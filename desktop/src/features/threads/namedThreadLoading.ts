import {
  applyNamedThreadActivity,
  isNewerNamedThreadTitle,
  isNamedThreadRootEvent,
  parseNamedThreadTitleEdit,
  reduceNamedThreadTitleStates,
  retainNamedThreadsWithRootEvents,
  type NamedThread,
} from "@/features/threads/namedThreads";
import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { readArchivedEvents } from "@/shared/api/tauriArchive";
import type { RelayEvent } from "@/shared/api/types";
import {
  CHANNEL_MESSAGE_EVENT_KINDS,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_THREAD_TITLE,
} from "@/shared/constants/kinds";

export const THREAD_TITLE_EVENT_KINDS = [
  KIND_STREAM_THREAD_TITLE,
  KIND_STREAM_MESSAGE_EDIT,
] as const;

type NamedThreadLoadingDeps = {
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  readArchivedEvents: (
    channelId: string,
    kinds: number[],
    options?: {
      before?: { createdAt: number; id: string } | null;
      limit?: number;
    },
  ) => Promise<RelayEvent[]>;
};

const RELAY_PAGE_LIMIT = 2_000;
const ARCHIVE_PAGE_LIMIT = 1_000;
const MAX_HISTORY_PAGES = 100;
const ROOT_ID_BATCH_SIZE = 500;
const REPLY_ROOT_BATCH_SIZE = 250;

const defaultDeps: NamedThreadLoadingDeps = {
  fetchEvents: (filter) => relayClient.fetchEvents(filter),
  readArchivedEvents: (channelId, kinds, options) =>
    readArchivedEvents("channel_h", channelId, {
      kinds,
      before: options?.before,
      limit: options?.limit ?? ARCHIVE_PAGE_LIMIT,
    }),
};

function fulfilledEvents(
  result: PromiseSettledResult<RelayEvent[]>,
): RelayEvent[] {
  return result.status === "fulfilled" ? result.value : [];
}

function firstRejection<T>(results: PromiseSettledResult<T>[]): unknown {
  return results.find((result) => result.status === "rejected")?.reason;
}

export type NamedThreadActivityTarget = {
  channelId: string;
  rootId: string;
};

export type NamedThreadLoadSnapshot = {
  threads: NamedThread[];
  authoritativeChannelIds: string[];
  invalidRootStates: NamedThreadInvalidRootState[];
};

export type NamedThreadInvalidRootState = {
  channelId: string;
  rootId: string;
  titleEventId: string;
  titleUpdatedAt: number;
};

export function applyNamedThreadSnapshotActivity(
  snapshot: NamedThreadLoadSnapshot | undefined,
  events: RelayEvent[],
  currentPubkey?: string,
): NamedThreadLoadSnapshot {
  return {
    threads: applyNamedThreadActivity(
      snapshot?.threads ?? [],
      events,
      currentPubkey,
    ),
    authoritativeChannelIds: snapshot?.authoritativeChannelIds ?? [],
    invalidRootStates: snapshot?.invalidRootStates ?? [],
  };
}

export function namedThreadActivityTargetKey(threads: NamedThread[]): string {
  return JSON.stringify(
    threads
      .map(({ channelId, rootId }) => ({ channelId, rootId }))
      .sort(
        (left, right) =>
          left.channelId.localeCompare(right.channelId) ||
          left.rootId.localeCompare(right.rootId),
      ),
  );
}

export function namedThreadActivityTargetsFromKey(
  key: string,
): NamedThreadActivityTarget[] {
  return JSON.parse(key) as NamedThreadActivityTarget[];
}

function eventKey(event: RelayEvent): string {
  return event.id;
}

function dedupeEvents(events: RelayEvent[]): RelayEvent[] {
  return [...new Map(events.map((event) => [eventKey(event), event])).values()];
}

export async function fetchAllNamedThreadRelayEvents(
  filter: RelaySubscriptionFilter,
  fetchEvents: NamedThreadLoadingDeps["fetchEvents"] = defaultDeps.fetchEvents,
): Promise<RelayEvent[]> {
  const events: RelayEvent[] = [];
  let until = filter.until;
  let previousUntil: number | undefined;

  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
    const page = await fetchEvents({
      ...filter,
      limit: RELAY_PAGE_LIMIT,
      ...(until === undefined ? {} : { until }),
    });
    events.push(...page);
    if (page.length < RELAY_PAGE_LIMIT) return dedupeEvents(events);

    const oldestCreatedAt = Math.min(...page.map((event) => event.created_at));
    const boundary = await fetchEvents({
      ...filter,
      since: oldestCreatedAt,
      until: oldestCreatedAt,
      limit: RELAY_PAGE_LIMIT,
    });
    if (boundary.length >= RELAY_PAGE_LIMIT) {
      throw new Error(
        "Named-thread history cannot be paged safely: one second exceeds the relay page limit.",
      );
    }
    events.push(...boundary);

    const nextUntil = oldestCreatedAt - 1;
    if (
      (filter.since !== undefined && nextUntil < filter.since) ||
      nextUntil < 0
    ) {
      return dedupeEvents(events);
    }
    if (previousUntil !== undefined && nextUntil >= previousUntil) {
      throw new Error("Named-thread relay pagination made no progress.");
    }
    previousUntil = nextUntil;
    until = nextUntil;
  }

  throw new Error("Named-thread relay history exceeded the pagination budget.");
}

export async function fetchAllNamedThreadArchivedEvents(
  channelId: string,
  kinds: number[],
  readEvents: NamedThreadLoadingDeps["readArchivedEvents"] = defaultDeps.readArchivedEvents,
): Promise<RelayEvent[]> {
  const events: RelayEvent[] = [];
  let before: { createdAt: number; id: string } | null = null;
  let previousCursor = "";

  for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
    const page = await readEvents(channelId, kinds, {
      before,
      limit: ARCHIVE_PAGE_LIMIT,
    });
    events.push(...page);
    if (page.length < ARCHIVE_PAGE_LIMIT) return dedupeEvents(events);

    const last = page.at(-1);
    if (!last) return dedupeEvents(events);
    const cursor = `${last.created_at}:${last.id}`;
    if (cursor === previousCursor) {
      throw new Error("Named-thread archive pagination made no progress.");
    }
    previousCursor = cursor;
    before = { createdAt: last.created_at, id: last.id };
  }

  throw new Error(
    "Named-thread archive history exceeded the pagination budget.",
  );
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/**
 * A refetch can finish after a live title, clear, or reply was applied. Merge
 * title state by `(created_at, id)`, retain clear tombstones, and keep activity
 * frontiers monotonic. Missing title history is not deletion evidence: an
 * older in-flight snapshot can omit a live title or clear. A cached root is
 * removed only when the loader explicitly invalidated that exact title state.
 */
export function preserveNewerNamedThreadState(
  previous: NamedThread[] | undefined,
  loaded: NamedThread[],
  invalidRootStates: readonly NamedThreadInvalidRootState[] = [],
): NamedThread[] {
  if (!previous) return loaded;
  const invalidByRoot = new Map(
    invalidRootStates.map((state) => [
      `${state.channelId}:${state.rootId}`,
      state,
    ]),
  );
  const keys = new Set([
    ...previous.map((thread) => `${thread.channelId}:${thread.rootId}`),
    ...loaded.map((thread) => `${thread.channelId}:${thread.rootId}`),
  ]);
  const previousByRoot = new Map(
    previous.map((thread) => [`${thread.channelId}:${thread.rootId}`, thread]),
  );
  const loadedByRoot = new Map(
    loaded.map((thread) => [`${thread.channelId}:${thread.rootId}`, thread]),
  );
  return [...keys].flatMap((key) => {
    const prior = previousByRoot.get(key);
    const incoming = loadedByRoot.get(key);
    const invalid = invalidByRoot.get(key);
    if (
      prior &&
      invalid?.titleEventId === prior.titleEventId &&
      invalid.titleUpdatedAt === prior.titleUpdatedAt
    ) {
      return [];
    }
    if (!prior && incoming) return [incoming];
    if (!incoming && prior) {
      return [prior];
    }
    if (!prior || !incoming) {
      throw new Error("Named-thread state key has no matching record.");
    }
    const titleWinner = isNewerNamedThreadTitle(
      { id: prior.titleEventId, createdAt: prior.titleUpdatedAt },
      { id: incoming.titleEventId, createdAt: incoming.titleUpdatedAt },
    )
      ? prior
      : incoming;
    const lastReplyAt = maxNullable(incoming.lastReplyAt, prior.lastReplyAt);
    const lastIncomingReplyAt = maxNullable(
      incoming.lastIncomingReplyAt,
      prior.lastIncomingReplyAt,
    );
    return [
      {
        ...titleWinner,
        lastReplyAt: titleWinner.title.length > 0 ? lastReplyAt : null,
        lastIncomingReplyAt:
          titleWinner.title.length > 0 ? lastIncomingReplyAt : null,
        lastActivityAt:
          titleWinner.title.length > 0
            ? Math.max(titleWinner.titleUpdatedAt, lastReplyAt ?? 0)
            : titleWinner.titleUpdatedAt,
      },
    ];
  });
}

export const preserveNewerNamedThreadActivity = preserveNewerNamedThreadState;

export async function fetchNamedThreadActivityCatchUp(
  targets: NamedThreadActivityTarget[],
  fetchEvents: NamedThreadLoadingDeps["fetchEvents"] = defaultDeps.fetchEvents,
): Promise<RelayEvent[]> {
  const rootsByChannel = new Map<string, string[]>();
  for (const { channelId, rootId } of targets) {
    const roots = rootsByChannel.get(channelId) ?? [];
    roots.push(rootId);
    rootsByChannel.set(channelId, roots);
  }
  const results = await Promise.allSettled(
    [...rootsByChannel].flatMap(([channelId, rootIds]) =>
      Array.from(
        { length: Math.ceil(rootIds.length / REPLY_ROOT_BATCH_SIZE) },
        (_, index) =>
          fetchAllNamedThreadRelayEvents(
            {
              kinds: [...CHANNEL_MESSAGE_EVENT_KINDS],
              "#h": [channelId],
              "#e": rootIds.slice(
                index * REPLY_ROOT_BATCH_SIZE,
                (index + 1) * REPLY_ROOT_BATCH_SIZE,
              ),
              limit: RELAY_PAGE_LIMIT,
            },
            fetchEvents,
          ),
      ),
    ),
  );
  if (
    results.length > 0 &&
    results.every((result) => result.status === "rejected")
  ) {
    throw firstRejection(results);
  }
  return results.flatMap(fulfilledEvents);
}

/**
 * Loads one channel independently so a high-volume channel cannot consume the
 * global relay/archive limit and evict named threads from sibling channels.
 *
 * Relay history and the optional local archive are reduced together. That is
 * important for clears: a newer empty title from either source must suppress
 * an older non-empty title from the other source.
 */
type NamedThreadChannelSnapshot = {
  threads: NamedThread[];
  invalidRootStates: NamedThreadInvalidRootState[];
};

async function loadNamedThreadSnapshotForChannel(
  channelId: string,
  currentPubkey?: string,
  deps: NamedThreadLoadingDeps = defaultDeps,
  knownThreads: readonly NamedThread[] = [],
): Promise<NamedThreadChannelSnapshot> {
  const titleFilter: RelaySubscriptionFilter = {
    kinds: [...THREAD_TITLE_EVENT_KINDS],
    "#h": [channelId],
    limit: RELAY_PAGE_LIMIT,
  };
  const titleResults = await Promise.allSettled([
    fetchAllNamedThreadRelayEvents(titleFilter, deps.fetchEvents),
    fetchAllNamedThreadArchivedEvents(
      channelId,
      [...THREAD_TITLE_EVENT_KINDS],
      deps.readArchivedEvents,
    ),
  ]);
  const titleEvents = titleResults.flatMap(fulfilledEvents);
  const relayTitlesFailed = titleResults[0]?.status === "rejected";
  if (relayTitlesFailed && fulfilledEvents(titleResults[1]).length === 0) {
    throw (
      firstRejection(titleResults) ?? new Error("Relay history unavailable.")
    );
  }

  const titleStates = reduceNamedThreadTitleStates(
    titleEvents,
    new Set([channelId]),
  );
  const titledThreads = titleStates.filter((thread) => thread.title.length > 0);
  const tombstones = titleStates.filter((thread) => thread.title.length === 0);
  if (titledThreads.length === 0 && knownThreads.length === 0) {
    return { threads: tombstones, invalidRootStates: [] };
  }

  const rootIds = [
    ...new Set([
      ...titledThreads.map((thread) => thread.rootId),
      ...knownThreads.map((thread) => thread.rootId),
    ]),
  ];
  const activityRootIds = titledThreads.map((thread) => thread.rootId);
  const rootBatches = Array.from(
    { length: Math.ceil(rootIds.length / ROOT_ID_BATCH_SIZE) },
    (_, index) =>
      rootIds.slice(
        index * ROOT_ID_BATCH_SIZE,
        (index + 1) * ROOT_ID_BATCH_SIZE,
      ),
  );
  const replyBatches = Array.from(
    { length: Math.ceil(activityRootIds.length / REPLY_ROOT_BATCH_SIZE) },
    (_, index) =>
      activityRootIds.slice(
        index * REPLY_ROOT_BATCH_SIZE,
        (index + 1) * REPLY_ROOT_BATCH_SIZE,
      ),
  );
  const messageResults = await Promise.allSettled([
    Promise.all(
      rootBatches.map((ids) =>
        deps.fetchEvents({
          ids,
          kinds: [...CHANNEL_MESSAGE_EVENT_KINDS],
          "#h": [channelId],
          limit: ids.length,
        }),
      ),
    ).then((pages) => pages.flat()),
    Promise.all(
      replyBatches.map((rootBatch) =>
        fetchAllNamedThreadRelayEvents(
          {
            kinds: [...CHANNEL_MESSAGE_EVENT_KINDS],
            "#h": [channelId],
            "#e": rootBatch,
            limit: RELAY_PAGE_LIMIT,
          },
          deps.fetchEvents,
        ),
      ),
    ).then((pages) => pages.flat()),
    fetchAllNamedThreadArchivedEvents(
      channelId,
      [...CHANNEL_MESSAGE_EVENT_KINDS],
      deps.readArchivedEvents,
    ),
  ]);
  const [relayRoots, relayReplies, archivedMessages] =
    messageResults.map(fulfilledEvents);
  const archivedValidThreads = retainNamedThreadsWithRootEvents(
    titledThreads,
    archivedMessages,
  );
  const rootRelayFailed = messageResults[0]?.status === "rejected";
  if (rootRelayFailed && archivedValidThreads.length !== titledThreads.length) {
    throw (
      firstRejection(messageResults) ??
      firstRejection(titleResults) ??
      new Error("Named-thread root validation is incomplete.")
    );
  }
  const validThreads = rootRelayFailed
    ? archivedValidThreads
    : retainNamedThreadsWithRootEvents(titledThreads, relayRoots);
  const validatedKnownThreads = retainNamedThreadsWithRootEvents(
    [...knownThreads],
    relayRoots,
  );
  const validKnownRootKeys = new Set(
    validatedKnownThreads.map(
      (thread) => `${thread.channelId}:${thread.rootId}`,
    ),
  );
  const invalidRootStates = rootRelayFailed
    ? []
    : knownThreads
        .filter(
          (thread) =>
            !validKnownRootKeys.has(`${thread.channelId}:${thread.rootId}`),
        )
        .map(({ channelId, rootId, titleEventId, titleUpdatedAt }) => ({
          channelId,
          rootId,
          titleEventId,
          titleUpdatedAt,
        }));

  return {
    threads: [
      ...applyNamedThreadActivity(
        validThreads,
        [...relayReplies, ...archivedMessages],
        currentPubkey,
      ),
      ...tombstones,
    ],
    invalidRootStates,
  };
}

export async function loadNamedThreadsForChannel(
  channelId: string,
  currentPubkey?: string,
  deps: NamedThreadLoadingDeps = defaultDeps,
): Promise<NamedThread[]> {
  return (
    await loadNamedThreadSnapshotForChannel(channelId, currentPubkey, deps)
  ).threads;
}

export async function loadNamedThreadsForChannels(
  channelIds: string[],
  currentPubkey?: string,
  deps: NamedThreadLoadingDeps = defaultDeps,
  knownThreads: readonly NamedThread[] = [],
): Promise<NamedThreadLoadSnapshot> {
  const perChannel = await Promise.allSettled(
    channelIds.map((channelId) =>
      loadNamedThreadSnapshotForChannel(
        channelId,
        currentPubkey,
        deps,
        knownThreads.filter((thread) => thread.channelId === channelId),
      ),
    ),
  );
  if (
    perChannel.length > 0 &&
    perChannel.every((result) => result.status === "rejected")
  ) {
    throw firstRejection(perChannel);
  }
  return {
    threads: perChannel.flatMap((result) =>
      result.status === "fulfilled" ? result.value.threads : [],
    ),
    authoritativeChannelIds: channelIds.filter(
      (_channelId, index) => perChannel[index]?.status === "fulfilled",
    ),
    invalidRootStates: perChannel.flatMap((result) =>
      result.status === "fulfilled" ? result.value.invalidRootStates : [],
    ),
  };
}

export async function isLiveNamedThreadTitleTargetValid(
  event: RelayEvent,
  allowedChannelIds: ReadonlySet<string>,
): Promise<boolean> {
  const parsed = parseNamedThreadTitleEdit(event, allowedChannelIds);
  if (!parsed) return false;
  // A clear can only remove a row that was already root-validated. Requiring
  // the root again would strand stale rows after the root itself was deleted.
  if (parsed.title.length === 0) return true;
  const rootEvents = await relayClient.fetchEvents({
    ids: [parsed.rootId],
    kinds: [...CHANNEL_MESSAGE_EVENT_KINDS],
    "#h": [parsed.channelId],
    limit: 1,
  });
  return rootEvents.some(
    (rootEvent) =>
      rootEvent.id === parsed.rootId && isNamedThreadRootEvent(rootEvent),
  );
}
