import { CornerDownRight } from "lucide-react";

import { useAppShell } from "@/app/AppShellContext";
import {
  namedThreadsForChannel,
  type NamedThread,
} from "@/features/threads/namedThreads";
import { cn } from "@/shared/lib/cn";
import { SidebarMenuButton, SidebarMenuItem } from "@/shared/ui/sidebar";

export function NamedThreadRows({
  channelId,
  namedThreads,
  onSelectThread,
  selectedThreadRootId,
}: {
  channelId: string;
  namedThreads: NamedThread[];
  onSelectThread?: (channelId: string, rootId: string) => void;
  selectedThreadRootId?: string | null;
}) {
  const { getThreadReadAt, readStateVersion } = useAppShell();
  const threads = namedThreadsForChannel(namedThreads, channelId);

  // `readStateVersion` is the intentional invalidation signal for the stable
  // read-marker getter.
  void readStateVersion;
  return threads.map((thread, index) => {
    const isActive = selectedThreadRootId === thread.rootId;
    const isLast = index === threads.length - 1;
    const readAt = getThreadReadAt(thread.rootId, channelId) ?? 0;
    const hasUnread =
      !isActive &&
      thread.lastIncomingReplyAt !== null &&
      thread.lastIncomingReplyAt > readAt;
    return (
      <SidebarMenuItem
        className={cn(
          "content-visibility-auto-row before:pointer-events-none before:absolute before:left-5 before:top-0 before:w-px before:bg-sidebar-border/70 before:content-['']",
          isLast ? "before:bottom-1/2" : "before:bottom-0",
        )}
        key={thread.rootId}
      >
        <SidebarMenuButton
          aria-label={`Open thread ${thread.title}`}
          className={cn(
            "pl-7 pr-2 text-sidebar-foreground/70",
            hasUnread &&
              "font-semibold text-sidebar-foreground hover:text-sidebar-foreground",
          )}
          data-channel-id={channelId}
          data-thread-root-id={thread.rootId}
          data-testid={`named-thread-${thread.rootId}`}
          isActive={isActive}
          onClick={() => onSelectThread?.(channelId, thread.rootId)}
          size="sm"
          title={thread.title}
          tooltip={thread.title}
          type="button"
        >
          <CornerDownRight className="size-3.5 opacity-55" />
          <span className="min-w-0 flex-1 truncate" title={thread.title}>
            {thread.title}
          </span>
          {hasUnread ? (
            <span
              className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
              data-testid={`named-thread-unread-${thread.rootId}`}
            >
              <span className="sr-only">Unread replies</span>
            </span>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  });
}
