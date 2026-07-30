import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_THREAD_TITLE,
} from "@/shared/constants/kinds";

export const THREAD_TITLE_MARKER = "buzz-thread-title";
export const MAX_THREAD_TITLE_LENGTH = 80;
export const MAX_NAMED_THREADS_PER_CHANNEL = 12;
export const NAMED_THREAD_QUERY_LIMIT = 1_000;

export type NamedThread = {
  channelId: string;
  rootId: string;
  title: string;
  titleEventId: string;
  titleUpdatedAt: number;
  lastReplyAt: number | null;
  lastIncomingReplyAt: number | null;
  lastActivityAt: number;
};

type ParsedThreadTitleEdit = {
  channelId: string;
  rootId: string;
  title: string;
  titleEventId: string;
  titleUpdatedAt: number;
};

function tagValue(tags: string[][] | undefined, name: string): string | null {
  return tags?.find((tag) => tag[0] === name)?.[1] ?? null;
}

function isNewer(
  candidate: { id: string; createdAt: number },
  current: { id: string; createdAt: number },
): boolean {
  return (
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id > current.id)
  );
}

export function normalizeThreadTitle(value: string): string {
  const collapsed = value.trim().replace(/\s+/g, " ");
  return Array.from(collapsed).slice(0, MAX_THREAD_TITLE_LENGTH).join("");
}

export function deriveFallbackThreadTitle(body: string): string {
  const firstLine =
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const withoutCommonMarkdown = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "");
  return normalizeThreadTitle(withoutCommonMarkdown) || "Untitled thread";
}

export function explicitThreadTitleFromTags(
  tags: string[][] | undefined,
): string | null {
  const subject = tagValue(tags, "subject");
  if (subject === null) return null;
  return normalizeThreadTitle(subject) || null;
}

export function parseNamedThreadTitleEdit(
  event: RelayEvent,
  allowedChannelIds?: ReadonlySet<string>,
): ParsedThreadTitleEdit | null {
  if (
    event.kind !== KIND_STREAM_THREAD_TITLE &&
    event.kind !== KIND_STREAM_MESSAGE_EDIT
  ) {
    return null;
  }
  if (
    !event.tags.some((tag) => tag[0] === "t" && tag[1] === THREAD_TITLE_MARKER)
  ) {
    return null;
  }
  const channelId = tagValue(event.tags, "h");
  const rootId = tagValue(event.tags, "e");
  const rawSubject = tagValue(event.tags, "subject");
  if (
    !channelId ||
    !rootId ||
    rawSubject === null ||
    (allowedChannelIds && !allowedChannelIds.has(channelId))
  ) {
    return null;
  }
  return {
    channelId,
    rootId,
    title: normalizeThreadTitle(rawSubject),
    titleEventId: event.id,
    titleUpdatedAt: event.created_at,
  };
}

export function reduceNamedThreadTitleEdits(
  events: RelayEvent[],
  allowedChannelIds?: ReadonlySet<string>,
): NamedThread[] {
  const latestByRoot = new Map<string, ParsedThreadTitleEdit>();
  for (const event of events) {
    const parsed = parseNamedThreadTitleEdit(event, allowedChannelIds);
    if (!parsed) continue;
    const key = `${parsed.channelId}:${parsed.rootId}`;
    const existing = latestByRoot.get(key);
    if (
      !existing ||
      isNewer(
        { id: parsed.titleEventId, createdAt: parsed.titleUpdatedAt },
        { id: existing.titleEventId, createdAt: existing.titleUpdatedAt },
      )
    ) {
      latestByRoot.set(key, parsed);
    }
  }

  return [...latestByRoot.values()]
    .filter((thread) => thread.title.length > 0)
    .map((thread) => ({
      ...thread,
      lastReplyAt: null,
      lastIncomingReplyAt: null,
      lastActivityAt: thread.titleUpdatedAt,
    }));
}

export function upsertNamedThreadTitleEvent(
  threads: NamedThread[],
  event: RelayEvent,
  allowedChannelIds?: ReadonlySet<string>,
): NamedThread[] {
  const parsed = parseNamedThreadTitleEdit(event, allowedChannelIds);
  if (!parsed) return threads;
  const index = threads.findIndex(
    (thread) =>
      thread.channelId === parsed.channelId && thread.rootId === parsed.rootId,
  );
  const existing = index >= 0 ? threads[index] : null;
  if (
    existing &&
    !isNewer(
      { id: parsed.titleEventId, createdAt: parsed.titleUpdatedAt },
      { id: existing.titleEventId, createdAt: existing.titleUpdatedAt },
    )
  ) {
    return threads;
  }
  if (!parsed.title) {
    return existing
      ? threads.filter((_, threadIndex) => threadIndex !== index)
      : threads;
  }
  const next: NamedThread = {
    channelId: parsed.channelId,
    rootId: parsed.rootId,
    title: parsed.title,
    titleEventId: parsed.titleEventId,
    titleUpdatedAt: parsed.titleUpdatedAt,
    lastReplyAt: existing?.lastReplyAt ?? null,
    lastIncomingReplyAt: existing?.lastIncomingReplyAt ?? null,
    lastActivityAt: Math.max(parsed.titleUpdatedAt, existing?.lastReplyAt ?? 0),
  };
  if (!existing) return [...threads, next];
  return threads.map((thread, threadIndex) =>
    threadIndex === index ? next : thread,
  );
}

export function applyNamedThreadActivity(
  threads: NamedThread[],
  events: RelayEvent[],
  currentPubkey?: string,
): NamedThread[] {
  if (threads.length === 0 || events.length === 0) return threads;
  const current = currentPubkey?.toLowerCase();
  const byChannelAndRoot = new Map(
    threads.map((thread) => [`${thread.channelId}:${thread.rootId}`, thread]),
  );
  const next = new Map(
    threads.map((thread) => [
      `${thread.channelId}:${thread.rootId}`,
      { ...thread },
    ]),
  );

  for (const event of events) {
    const channelId = tagValue(event.tags, "h");
    if (!channelId) continue;
    const referencedRoots = new Set(
      event.tags.filter((tag) => tag[0] === "e" && tag[1]).map((tag) => tag[1]),
    );
    for (const rootId of referencedRoots) {
      const key = `${channelId}:${rootId}`;
      if (!byChannelAndRoot.has(key)) continue;
      const thread = next.get(key);
      if (!thread) continue;
      thread.lastReplyAt = Math.max(thread.lastReplyAt ?? 0, event.created_at);
      if (!current || event.pubkey.toLowerCase() !== current) {
        thread.lastIncomingReplyAt = Math.max(
          thread.lastIncomingReplyAt ?? 0,
          event.created_at,
        );
      }
      thread.lastActivityAt = Math.max(
        thread.titleUpdatedAt,
        thread.lastReplyAt,
      );
    }
  }

  return [...next.values()];
}

export function namedThreadsForChannel(
  threads: NamedThread[],
  channelId: string,
  limit = MAX_NAMED_THREADS_PER_CHANNEL,
): NamedThread[] {
  return threads
    .filter((thread) => thread.channelId === channelId)
    .sort(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt ||
        right.titleUpdatedAt - left.titleUpdatedAt ||
        right.titleEventId.localeCompare(left.titleEventId),
    )
    .slice(0, limit);
}
