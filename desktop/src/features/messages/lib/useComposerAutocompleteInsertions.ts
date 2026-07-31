import * as React from "react";

import {
  slashCommandOptionId,
  type SlashCommandSuggestion,
} from "./slashCommandAutocomplete";
import type { useChannelLinks } from "./useChannelLinks";
import type { useEmojiAutocomplete } from "./useEmojiAutocomplete";
import type { useMentions } from "./useMentions";
import type {
  AutocompleteEdit,
  UseRichTextEditorResult,
} from "./useRichTextEditor";
import type { useSlashCommandAutocomplete } from "./useSlashCommandAutocomplete";

type ChannelLinks = ReturnType<typeof useChannelLinks>;
type EmojiAutocomplete = ReturnType<typeof useEmojiAutocomplete>;
type Mentions = ReturnType<typeof useMentions>;
type SlashCommands = ReturnType<typeof useSlashCommandAutocomplete>;

export function getMountedEditorElement(
  editor: UseRichTextEditorResult["editor"],
): HTMLElement | null {
  if (!editor) return null;
  try {
    return editor.view.dom;
  } catch {
    return null;
  }
}

export function handleAutocompleteKeyResult<T>(
  result: { handled: boolean; suggestion?: T },
  onSelect: (suggestion: T) => void,
): boolean {
  if (result.suggestion) onSelect(result.suggestion);
  return result.handled;
}

export function useComposerAutocompleteInsertions({
  channelLinks,
  emojiAutocomplete,
  mentions,
  richText,
  slashCommands,
}: {
  channelLinks: ChannelLinks;
  emojiAutocomplete: EmojiAutocomplete;
  mentions: Mentions;
  richText: UseRichTextEditorResult;
  slashCommands: SlashCommands;
}) {
  const applyAutocompleteEdit = React.useCallback(
    (edit: AutocompleteEdit) => {
      richText.replacePlainTextRange(
        edit.replaceFromOffset,
        edit.replaceToOffset,
        edit.insertText,
        edit.customEmojiShortcode,
      );
    },
    [richText.replacePlainTextRange],
  );
  const mention = React.useCallback(
    (suggestion: Parameters<Mentions["insertMention"]>[0]) => {
      const { cursor } = richText.getPlainTextAndCursor();
      applyAutocompleteEdit(mentions.insertMention(suggestion, cursor));
    },
    [
      applyAutocompleteEdit,
      mentions.insertMention,
      richText.getPlainTextAndCursor,
    ],
  );
  const channel = React.useCallback(
    (suggestion: Parameters<ChannelLinks["insertChannel"]>[0]) => {
      const { cursor } = richText.getPlainTextAndCursor();
      applyAutocompleteEdit(channelLinks.insertChannel(suggestion, cursor));
    },
    [
      applyAutocompleteEdit,
      channelLinks.insertChannel,
      richText.getPlainTextAndCursor,
    ],
  );
  const emoji = React.useCallback(
    (suggestion: Parameters<EmojiAutocomplete["insertEmoji"]>[0]) => {
      const { cursor } = richText.getPlainTextAndCursor();
      applyAutocompleteEdit(emojiAutocomplete.insertEmoji(suggestion, cursor));
    },
    [
      applyAutocompleteEdit,
      emojiAutocomplete.insertEmoji,
      richText.getPlainTextAndCursor,
    ],
  );
  const slash = React.useCallback(
    (suggestion: SlashCommandSuggestion) => {
      const edit = slashCommands.insertCommand(suggestion);
      if (!edit) return;
      mentions.registerMentionPubkey(
        suggestion.agentDisplayName,
        suggestion.agentPubkey,
        { isAgent: true },
      );
      applyAutocompleteEdit(edit);
    },
    [
      applyAutocompleteEdit,
      mentions.registerMentionPubkey,
      slashCommands.insertCommand,
    ],
  );

  React.useEffect(() => {
    const editorElement = getMountedEditorElement(richText.editor);
    if (!editorElement) return;
    editorElement.setAttribute("aria-expanded", String(slashCommands.isOpen));
    if (slashCommands.isOpen) {
      editorElement.setAttribute("aria-autocomplete", "list");
      editorElement.setAttribute("aria-controls", slashCommands.listboxId);
      editorElement.setAttribute("aria-haspopup", "listbox");
      if (slashCommands.suggestions.length > 0) {
        editorElement.setAttribute(
          "aria-activedescendant",
          slashCommandOptionId(
            slashCommands.listboxId,
            slashCommands.selectedIndex,
          ),
        );
      } else {
        editorElement.removeAttribute("aria-activedescendant");
      }
    } else {
      editorElement.removeAttribute("aria-autocomplete");
      editorElement.removeAttribute("aria-controls");
      editorElement.removeAttribute("aria-haspopup");
      editorElement.removeAttribute("aria-activedescendant");
    }
    return () => {
      editorElement.removeAttribute("aria-expanded");
      editorElement.removeAttribute("aria-autocomplete");
      editorElement.removeAttribute("aria-controls");
      editorElement.removeAttribute("aria-haspopup");
      editorElement.removeAttribute("aria-activedescendant");
    };
  }, [
    richText.editor,
    slashCommands.isOpen,
    slashCommands.listboxId,
    slashCommands.selectedIndex,
    slashCommands.suggestions.length,
  ]);

  return { channel, emoji, mention, slash };
}
