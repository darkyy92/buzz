import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  THREAD_TITLE_MARKER,
  type NamedThread,
  upsertNamedThreadTitleStateEvent,
} from "@/features/threads/namedThreads";
import {
  applyNamedThreadSnapshotActivity,
  fetchNamedThreadActivityCatchUp,
  isLiveNamedThreadTitleTargetValid,
  loadNamedThreadsForChannels,
  type NamedThreadLoadSnapshot,
  namedThreadActivityTargetKey,
  namedThreadActivityTargetsFromKey,
  preserveNewerNamedThreadState,
  THREAD_TITLE_EVENT_KINDS,
} from "@/features/threads/namedThreadLoading";
import { relayClient } from "@/shared/api/relayClient";
import { setThreadTitle } from "@/shared/api/tauri";
import type { Channel } from "@/shared/api/types";
import { CHANNEL_MESSAGE_EVENT_KINDS } from "@/shared/constants/kinds";
import {
  persistThreadTitle,
  type SetThreadTitleInput,
} from "@/features/threads/threadTitlePersistence";

function namedThreadsQueryKey(channelIds: string[], currentPubkey?: string) {
  return [
    "named-threads",
    currentPubkey?.toLowerCase() ?? "anonymous",
    ...channelIds,
  ] as const;
}

export function useNamedThreadStatesQuery(
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
  const query = useQuery<NamedThreadLoadSnapshot>({
    enabled: normalizedChannelIds.length > 0,
    queryKey,
    queryFn: () => {
      const knownThreads =
        queryClient.getQueryData<NamedThreadLoadSnapshot>(queryKey)?.threads ??
        [];
      return loadNamedThreadsForChannels(
        normalizedChannelIds,
        currentPubkey,
        undefined,
        knownThreads,
      );
    },
    structuralSharing: (previous, loaded) => {
      const incoming = loaded as NamedThreadLoadSnapshot;
      return {
        ...incoming,
        threads: preserveNewerNamedThreadState(
          (previous as NamedThreadLoadSnapshot | undefined)?.threads,
          incoming.threads,
          incoming.invalidRootStates,
        ),
      };
    },
    staleTime: 30_000,
    refetchInterval: 120_000,
  });

  const titleStates = query.data?.threads ?? [];
  const namedThreads = React.useMemo(
    () => titleStates.filter((thread) => thread.title.length > 0),
    [titleStates],
  );
  const activityTargetKey = React.useMemo(
    () => namedThreadActivityTargetKey(namedThreads),
    [namedThreads],
  );
  const activityTargets = React.useMemo(
    () => namedThreadActivityTargetsFromKey(activityTargetKey),
    [activityTargetKey],
  );
  const rootIds = React.useMemo(
    () => activityTargets.map((target) => target.rootId),
    [activityTargets],
  );

  React.useEffect(() => {
    if (normalizedChannelIds.length === 0) return;
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    void relayClient
      .subscribeLive(
        {
          kinds: [...THREAD_TITLE_EVENT_KINDS],
          "#h": normalizedChannelIds,
          "#t": [THREAD_TITLE_MARKER],
          limit: 0,
        },
        (event) => {
          void isLiveNamedThreadTitleTargetValid(event, allowedChannelIds)
            .then((isValid) => {
              if (!isValid || disposed) return;
              queryClient.setQueryData<NamedThreadLoadSnapshot>(
                queryKey,
                (old) => ({
                  threads: upsertNamedThreadTitleStateEvent(
                    old?.threads ?? [],
                    event,
                    allowedChannelIds,
                  ),
                  authoritativeChannelIds: old?.authoritativeChannelIds ?? [],
                  invalidRootStates: old?.invalidRootStates ?? [],
                }),
              );
            })
            .catch((error) => {
              console.error("Failed to validate named thread root", error);
            });
        },
      )
      .then((dispose) => {
        if (disposed) {
          void dispose();
        } else {
          unsubscribe = dispose;
          // Close the history-before-subscription race: anything published
          // after the first history request began is now covered either by
          // this live subscription or by the catch-up refetch.
          void queryClient.invalidateQueries({ queryKey });
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
          queryClient.setQueryData<NamedThreadLoadSnapshot>(queryKey, (old) =>
            applyNamedThreadSnapshotActivity(old, [event], currentPubkey),
          );
        },
      )
      .then((dispose) => {
        if (disposed) {
          void dispose();
        } else {
          unsubscribe = dispose;
          // Merge the history-before-subscription catch-up monotonically.
          // Invalidating the whole query here can overwrite a newer live
          // reply when the relay's history view is briefly behind.
          void fetchNamedThreadActivityCatchUp(activityTargets)
            .then((events) => {
              if (disposed) return;
              queryClient.setQueryData<NamedThreadLoadSnapshot>(
                queryKey,
                (old) =>
                  applyNamedThreadSnapshotActivity(old, events, currentPubkey),
              );
            })
            .catch((error) => {
              console.error("Failed to catch up named thread activity", error);
            });
        }
      })
      .catch((error) => {
        console.error("Failed to subscribe to named thread activity", error);
      });
    return () => {
      disposed = true;
      void unsubscribe?.();
    };
  }, [activityTargets, currentPubkey, queryClient, queryKey, rootIds]);

  React.useEffect(
    () =>
      relayClient.subscribeToReconnects(() => {
        void queryClient.invalidateQueries({ queryKey });
      }),
    [queryClient, queryKey],
  );

  return titleStates;
}

export function useNamedThreadsQuery(
  channelIds: string[],
  currentPubkey?: string,
): NamedThread[] {
  const titleStates = useNamedThreadStatesQuery(channelIds, currentPubkey);
  return React.useMemo(
    () => titleStates.filter((thread) => thread.title.length > 0),
    [titleStates],
  );
}

export function useSetThreadTitle() {
  const queryClient = useQueryClient();
  return React.useCallback(
    (input: SetThreadTitleInput): Promise<string> =>
      persistThreadTitle(input, {
        persist: setThreadTitle,
        refresh: () =>
          queryClient.invalidateQueries({ queryKey: ["named-threads"] }),
      }),
    [queryClient],
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
