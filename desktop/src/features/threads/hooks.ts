import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  applyNamedThreadActivity,
  NAMED_THREAD_QUERY_LIMIT,
  normalizeThreadTitle,
  reduceNamedThreadTitleEdits,
  THREAD_TITLE_MARKER,
  type NamedThread,
  upsertNamedThreadTitleEvent,
} from "@/features/threads/namedThreads";
import { relayClient } from "@/shared/api/relayClient";
import { editMessage } from "@/shared/api/tauri";
import type { Channel, RelayEvent } from "@/shared/api/types";
import {
  CHANNEL_MESSAGE_EVENT_KINDS,
  KIND_STREAM_MESSAGE_EDIT,
} from "@/shared/constants/kinds";

type SetThreadTitleInput = {
  body: string;
  channelId: string;
  rootId: string;
  tags?: string[][];
  title: string;
};

function namedThreadsQueryKey(channelIds: string[], currentPubkey?: string) {
  return [
    "named-threads",
    currentPubkey?.toLowerCase() ?? "anonymous",
    ...channelIds,
  ] as const;
}

export function useNamedThreadsQuery(
  channelIds: string[],
  currentPubkey?: string,
): NamedThread[] {
  const queryClient = useQueryClient();
  const normalizedChannelIds = React.useMemo(
    () => [...new Set(channelIds)].sort(),
    [channelIds],
  );
  const allowedChannelIds = React.useMemo(
    () => new Set(normalizedChannelIds),
    [normalizedChannelIds],
  );
  const queryKey = React.useMemo(
    () => namedThreadsQueryKey(normalizedChannelIds, currentPubkey),
    [currentPubkey, normalizedChannelIds],
  );
  const query = useQuery({
    enabled: normalizedChannelIds.length > 0,
    queryKey,
    queryFn: async (): Promise<NamedThread[]> => {
      const titleEvents = await relayClient.fetchEvents({
        kinds: [KIND_STREAM_MESSAGE_EDIT],
        "#h": normalizedChannelIds,
        "#t": [THREAD_TITLE_MARKER],
        limit: NAMED_THREAD_QUERY_LIMIT,
      });
      const titledThreads = reduceNamedThreadTitleEdits(
        titleEvents,
        allowedChannelIds,
      );
      if (titledThreads.length === 0) return [];
      const replyEvents = await relayClient.fetchEvents({
        kinds: [...CHANNEL_MESSAGE_EVENT_KINDS],
        "#e": titledThreads.map((thread) => thread.rootId),
        limit: NAMED_THREAD_QUERY_LIMIT,
      });
      return applyNamedThreadActivity(
        titledThreads,
        replyEvents,
        currentPubkey,
      );
    },
    staleTime: 30_000,
    refetchInterval: 120_000,
  });

  const namedThreads = query.data ?? [];
  const rootIds = React.useMemo(
    () => namedThreads.map((thread) => thread.rootId).sort(),
    [namedThreads],
  );

  React.useEffect(() => {
    if (normalizedChannelIds.length === 0) return;
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    void relayClient
      .subscribeLive(
        {
          kinds: [KIND_STREAM_MESSAGE_EDIT],
          "#h": normalizedChannelIds,
          "#t": [THREAD_TITLE_MARKER],
          limit: 0,
        },
        (event) => {
          queryClient.setQueryData<NamedThread[]>(queryKey, (old = []) =>
            upsertNamedThreadTitleEvent(old, event, allowedChannelIds),
          );
        },
      )
      .then((dispose) => {
        if (disposed) {
          void dispose();
        } else {
          unsubscribe = dispose;
        }
      })
      .catch((error) => {
        console.error("Failed to subscribe to named thread titles", error);
      });
    return () => {
      disposed = true;
      void unsubscribe?.();
    };
  }, [allowedChannelIds, normalizedChannelIds, queryClient, queryKey]);

  React.useEffect(() => {
    if (rootIds.length === 0) return;
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    void relayClient
      .subscribeLive(
        {
          kinds: [...CHANNEL_MESSAGE_EVENT_KINDS],
          "#e": rootIds,
          limit: 0,
        },
        (event) => {
          queryClient.setQueryData<NamedThread[]>(queryKey, (old = []) =>
            applyNamedThreadActivity(old, [event], currentPubkey),
          );
        },
      )
      .then((dispose) => {
        if (disposed) {
          void dispose();
        } else {
          unsubscribe = dispose;
        }
      })
      .catch((error) => {
        console.error("Failed to subscribe to named thread activity", error);
      });
    return () => {
      disposed = true;
      void unsubscribe?.();
    };
  }, [currentPubkey, queryClient, queryKey, rootIds]);

  React.useEffect(
    () =>
      relayClient.subscribeToReconnects(() => {
        void queryClient.invalidateQueries({ queryKey });
      }),
    [queryClient, queryKey],
  );

  return namedThreads;
}

export function useSetThreadTitle(currentPubkey?: string) {
  const queryClient = useQueryClient();
  return React.useCallback(
    async (input: SetThreadTitleInput): Promise<string> => {
      const title = normalizeThreadTitle(input.title);
      const imetaTags = input.tags?.filter((tag) => tag[0] === "imeta") ?? [];
      const emojiTags = input.tags?.filter((tag) => tag[0] === "emoji") ?? [];
      await editMessage(
        input.channelId,
        input.rootId,
        input.body,
        imetaTags,
        emojiTags,
        undefined,
        title,
      );

      const syntheticEvent: RelayEvent = {
        id: `local-thread-title-${crypto.randomUUID()}`,
        pubkey: currentPubkey ?? "",
        created_at: Math.floor(Date.now() / 1_000),
        kind: KIND_STREAM_MESSAGE_EDIT,
        tags: [
          ["h", input.channelId],
          ["e", input.rootId],
          ["subject", title],
          ["t", THREAD_TITLE_MARKER],
        ],
        content: input.body,
        sig: "",
      };
      queryClient.setQueriesData<NamedThread[]>(
        { queryKey: ["named-threads"] },
        (old = []) => upsertNamedThreadTitleEvent(old, syntheticEvent),
      );
      void queryClient.invalidateQueries({ queryKey: ["named-threads"] });
      return title;
    },
    [currentPubkey, queryClient],
  );
}

export function useThreadSidebarProps(
  channels: Channel[],
  currentPubkey?: string,
) {
  const channelIds = React.useMemo(
    () => channels.map((channel) => channel.id),
    [channels],
  );
  const namedThreads = useNamedThreadsQuery(channelIds, currentPubkey);
  const { goChannel } = useAppNavigation();
  const location = useLocation();
  const search = location.search as {
    thread?: unknown;
    threadRootId?: unknown;
  };
  const selectedThreadRootId =
    typeof search.threadRootId === "string"
      ? search.threadRootId
      : typeof search.thread === "string"
        ? search.thread
        : null;
  const onSelectThread = React.useCallback(
    (channelId: string, rootId: string) => {
      void goChannel(channelId, {
        messageId: rootId,
        threadRootId: rootId,
      });
    },
    [goChannel],
  );
  return { namedThreads, onSelectThread, selectedThreadRootId };
}
