import * as React from "react";

import {
  mergeAgentCommandCatalogs,
  useRelayAgentCommandCatalog,
} from "@/features/agents/relayAgentCommandCatalog";
import { useAgentCommandCatalog } from "@/features/agents/useAgentCommandCatalog";
import { useChannelMembersQuery } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import type { AutocompleteEdit } from "./useRichTextEditor";
import {
  buildSlashCommandInsertText,
  buildSlashCommandMenu,
  detectSlashCommandQuery,
  getSlashCommandFooterMessage,
  resolveLeadingAgentMentionPubkeys,
  slashCommandListboxId,
  type SlashCommandQuery,
  type SlashCommandSuggestion,
} from "./slashCommandAutocomplete";

type ActiveQuery = {
  detected: SlashCommandQuery;
  selectedAgentPubkeys: readonly string[] | null;
  signature: string;
};

export function useSlashCommandAutocomplete({
  channelId,
  ownerPubkey,
}: {
  channelId: string | null;
  ownerPubkey: string | null;
}) {
  const membersQuery = useChannelMembersQuery(channelId, Boolean(channelId));
  const instanceId = React.useId();
  const listboxId = slashCommandListboxId(instanceId);
  const { activeCommunity } = useCommunities();
  const relayUrl = activeCommunity?.relayUrl ?? null;
  const acpCatalog = useAgentCommandCatalog(ownerPubkey, relayUrl);
  const [activeQuery, setActiveQuery] = React.useState<ActiveQuery | null>(
    null,
  );
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const dismissedSignatureRef = React.useRef<string | null>(null);

  const providers = React.useMemo(
    () =>
      (membersQuery.data ?? [])
        .filter((member) => member.isAgent || member.role === "bot")
        .map((member) => ({
          pubkey: normalizePubkey(member.pubkey),
          displayName:
            member.displayName?.trim() || truncatePubkey(member.pubkey),
        })),
    [membersQuery.data],
  );
  const providerPubkeys = React.useMemo(
    () => providers.map((provider) => provider.pubkey),
    [providers],
  );
  const relayCatalog = useRelayAgentCommandCatalog(providerPubkeys, relayUrl);
  const catalog = React.useMemo(
    () => mergeAgentCommandCatalogs(acpCatalog, relayCatalog),
    [acpCatalog, relayCatalog],
  );

  const menu = React.useMemo(
    () =>
      activeQuery
        ? buildSlashCommandMenu({
            catalog,
            providers,
            query: activeQuery.detected.query,
            selectedAgentPubkeys: activeQuery.selectedAgentPubkeys,
          })
        : {
            displayedCount: 0,
            groups: [],
            totalCommandCount: 0,
            totalMatchCount: 0,
          },
    [activeQuery, catalog, providers],
  );
  const groups = menu.groups;
  const suggestions = React.useMemo(
    () => groups.flatMap((group) => group.commands),
    [groups],
  );
  const hasAnyCommands = menu.totalCommandCount > 0;
  const isOpen =
    activeQuery !== null && (suggestions.length > 0 || hasAnyCommands);
  const emptyMessage =
    isOpen && suggestions.length === 0
      ? activeQuery?.selectedAgentPubkeys
        ? "No matching commands for the mentioned agent"
        : "No matching commands"
      : null;
  const footerMessage =
    isOpen && activeQuery
      ? getSlashCommandFooterMessage(menu, activeQuery.detected.query)
      : null;

  React.useEffect(() => {
    setSelectedIndex((current) =>
      suggestions.length === 0 ? 0 : Math.min(current, suggestions.length - 1),
    );
  }, [suggestions.length]);

  const updateQuery = React.useCallback(
    (value: string, cursorPosition: number) => {
      const detected = detectSlashCommandQuery(value, cursorPosition);
      if (!detected) {
        dismissedSignatureRef.current = null;
        setActiveQuery(null);
        setSelectedIndex(0);
        return;
      }

      let selectedAgentPubkeys: readonly string[] | null = null;
      if (detected.leadingText) {
        selectedAgentPubkeys = resolveLeadingAgentMentionPubkeys(
          detected.leadingText,
          providers,
        );
        if (selectedAgentPubkeys.length === 0) {
          setActiveQuery(null);
          setSelectedIndex(0);
          return;
        }
      }

      const signature = `${detected.replaceFromOffset}:${detected.replaceToOffset}:${detected.leadingText}:${detected.query}`;
      if (dismissedSignatureRef.current === signature) {
        setActiveQuery(null);
        return;
      }
      dismissedSignatureRef.current = null;
      setActiveQuery({ detected, selectedAgentPubkeys, signature });
      setSelectedIndex(0);
    },
    [providers],
  );

  const insertCommand = React.useCallback(
    (suggestion: SlashCommandSuggestion): AutocompleteEdit | null => {
      if (!activeQuery) return null;
      const edit = {
        replaceFromOffset: activeQuery.detected.replaceFromOffset,
        replaceToOffset: activeQuery.detected.replaceToOffset,
        insertText: buildSlashCommandInsertText(
          suggestion,
          activeQuery.selectedAgentPubkeys !== null,
        ),
      };
      setActiveQuery(null);
      setSelectedIndex(0);
      return edit;
    },
    [activeQuery],
  );

  const handleKeyDown = React.useCallback(
    (
      event: React.KeyboardEvent,
    ): { handled: boolean; suggestion?: SlashCommandSuggestion } => {
      if (!isOpen || !activeQuery) return { handled: false };
      if (event.key === "Escape") {
        event.preventDefault();
        dismissedSignatureRef.current = activeQuery.signature;
        setActiveQuery(null);
        setSelectedIndex(0);
        return { handled: true };
      }
      if (suggestions.length === 0) return { handled: false };
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) =>
          current < suggestions.length - 1 ? current + 1 : 0,
        );
        return { handled: true };
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) =>
          current > 0 ? current - 1 : suggestions.length - 1,
        );
        return { handled: true };
      }
      if (
        (event.key === "Tab" || event.key === "Enter") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        return { handled: true, suggestion: suggestions[selectedIndex] };
      }
      return { handled: false };
    },
    [activeQuery, isOpen, selectedIndex, suggestions],
  );

  return {
    groups,
    handleKeyDown,
    insertCommand,
    emptyMessage,
    footerMessage,
    isOpen,
    listboxId,
    selectedIndex,
    suggestions,
    updateQuery,
  };
}
