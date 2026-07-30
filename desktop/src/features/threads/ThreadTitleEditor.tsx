import * as React from "react";
import { Check, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import type { TimelineMessage } from "@/features/messages/types";
import {
  deriveFallbackThreadTitle,
  explicitThreadTitleFromTags,
  MAX_THREAD_TITLE_LENGTH,
} from "@/features/threads/namedThreads";
import {
  useNamedThreadsQuery,
  useSetThreadTitle,
} from "@/features/threads/hooks";
import { AuxiliaryPanelTitle } from "@/shared/layout/AuxiliaryPanel";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

export function ThreadTitleEditor({
  canRename,
  channelId,
  currentPubkey,
  threadHead,
}: {
  canRename: boolean;
  channelId: string;
  currentPubkey?: string;
  threadHead: TimelineMessage;
}) {
  const setThreadTitle = useSetThreadTitle(currentPubkey);
  const titleChannelIds = React.useMemo(() => [channelId], [channelId]);
  const persistedTitle = useNamedThreadsQuery(
    titleChannelIds,
    currentPubkey,
  ).find((thread) => thread.rootId === threadHead.id)?.title;
  const [savedTitle, setSavedTitle] = React.useState<string | null | undefined>(
    undefined,
  );
  const explicitTitle =
    savedTitle !== undefined
      ? savedTitle
      : (persistedTitle ?? explicitThreadTitleFromTags(threadHead.tags));
  const displayTitle =
    explicitTitle ?? deriveFallbackThreadTitle(threadHead.body);
  const [isEditing, setIsEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(displayTitle);
  const [isSaving, setIsSaving] = React.useState(false);

  const beginEditing = React.useCallback(() => {
    setDraft(displayTitle);
    setIsEditing(true);
  }, [displayTitle]);
  const cancelEditing = React.useCallback(() => {
    setDraft(displayTitle);
    setIsEditing(false);
  }, [displayTitle]);
  const save = React.useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const saved = await setThreadTitle({
        body: threadHead.body,
        channelId,
        rootId: threadHead.id,
        tags: threadHead.tags,
        title: draft,
      });
      setSavedTitle(saved || null);
      setIsEditing(false);
    } catch (error) {
      toast.error("Could not rename thread", {
        description:
          error instanceof Error ? error.message : "The relay rejected it.",
      });
    } finally {
      setIsSaving(false);
    }
  }, [channelId, draft, isSaving, setThreadTitle, threadHead]);

  if (isEditing) {
    return (
      <div
        className="flex min-w-0 flex-1 items-center gap-1"
        data-testid="thread-title-editor"
      >
        <Input
          aria-label="Thread title"
          autoFocus
          className="h-8 min-w-0 flex-1"
          disabled={isSaving}
          maxLength={MAX_THREAD_TITLE_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelEditing();
            }
          }}
          value={draft}
        />
        <Button
          aria-label="Save thread title"
          disabled={isSaving}
          onClick={() => void save()}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Check />
        </Button>
        <Button
          aria-label="Cancel thread title edit"
          disabled={isSaving}
          onClick={cancelEditing}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <X />
        </Button>
      </div>
    );
  }

  return (
    <div className="group/thread-title flex min-w-0 flex-1 items-center gap-1">
      <AuxiliaryPanelTitle
        data-testid="message-thread-title"
        title={displayTitle}
      >
        {displayTitle}
      </AuxiliaryPanelTitle>
      {canRename ? (
        <Button
          aria-label="Rename thread"
          className="shrink-0 opacity-60 group-hover/thread-title:opacity-100 focus-visible:opacity-100"
          data-testid="rename-thread"
          onClick={beginEditing}
          size="icon-xs"
          title="Rename thread"
          type="button"
          variant="ghost"
        >
          <Pencil />
        </Button>
      ) : null}
    </div>
  );
}
