import * as React from "react";

import type { MainTimelineEntry } from "@/features/messages/lib/threadPanel";
import type { TimelineMessage } from "@/features/messages/types";

export function resolveThreadReadFrontier({
  openedThreadHeadId,
  ready,
  replies,
  threadHead,
}: {
  openedThreadHeadId: string | null;
  ready: boolean;
  replies: ReadonlyArray<MainTimelineEntry>;
  threadHead: TimelineMessage | null;
}): { rootId: string; timestamp: number } | null {
  if (!ready || !threadHead || openedThreadHeadId === threadHead.id) {
    return null;
  }
  return {
    rootId: threadHead.id,
    timestamp: replies.reduce(
      (latest, entry) =>
        Math.max(
          latest,
          entry.message.createdAt,
          entry.summary?.lastReplyAt ?? 0,
        ),
      threadHead.createdAt,
    ),
  };
}

export function useMarkThreadReadOnOpen({
  markThreadRead,
  ready,
  replies,
  threadHead,
}: {
  markThreadRead: (rootId: string, timestamp: number) => void;
  ready: boolean;
  replies: MainTimelineEntry[];
  threadHead: TimelineMessage | null;
}) {
  const openedThreadHeadIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const frontier = resolveThreadReadFrontier({
      openedThreadHeadId: openedThreadHeadIdRef.current,
      ready,
      replies,
      threadHead,
    });
    if (!frontier) return;
    openedThreadHeadIdRef.current = frontier.rootId;
    markThreadRead(frontier.rootId, frontier.timestamp);
  }, [markThreadRead, ready, replies, threadHead]);
}
