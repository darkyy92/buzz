import type { AgentCommandCatalog } from "@/features/agents/agentCommandCatalog";

export const SLASH_COMMAND_LISTBOX_ID = "message-composer-slash-commands";
export const SLASH_COMMAND_EMPTY_LIMIT_PER_AGENT = 12;
export const SLASH_COMMAND_MATCH_LIMIT = 50;

export function slashCommandOptionId(index: number): string {
  return `${SLASH_COMMAND_LISTBOX_ID}-option-${index}`;
}

export type SlashCommandProvider = {
  pubkey: string;
  displayName: string;
};

export type AgentMentionCandidate = {
  displayName: string;
  pubkey: string;
};

export type SlashCommandSuggestion = {
  agentDisplayName: string;
  agentPubkey: string;
  description: string | null;
  name: string;
};

export type SlashCommandGroup = {
  agentDisplayName: string;
  agentPubkey: string;
  commands: readonly SlashCommandSuggestion[];
};

export type SlashCommandMenu = {
  groups: readonly SlashCommandGroup[];
  displayedCount: number;
  totalCommandCount: number;
  totalMatchCount: number;
};

export function getSlashCommandFooterMessage(
  menu: SlashCommandMenu,
  query: string,
): string | null {
  if (query === "") {
    return menu.displayedCount < menu.totalCommandCount
      ? `Type to search all ${menu.totalCommandCount} commands`
      : null;
  }
  return menu.displayedCount < menu.totalMatchCount
    ? `Showing ${menu.displayedCount} of ${menu.totalMatchCount} matches. Refine your search.`
    : null;
}

export type SlashCommandQuery = {
  leadingText: string;
  query: string;
  replaceFromOffset: number;
  replaceToOffset: number;
};

export function detectSlashCommandQuery(
  value: string,
  cursorPosition: number,
): SlashCommandQuery | null {
  if (cursorPosition < 0 || cursorPosition > value.length) return null;
  if (value.includes("\n")) return null;
  const beforeCursor = value.slice(0, cursorPosition);

  const slashIndex = beforeCursor.lastIndexOf("/");
  if (slashIndex < 0) return null;
  const leadingText = beforeCursor.slice(0, slashIndex);
  const query = beforeCursor.slice(slashIndex + 1);
  if (/\s|\//u.test(query)) return null;
  const suffix = value.slice(cursorPosition).match(/^[^\s]*/u)?.[0] ?? "";
  if (suffix.includes("/")) return null;
  if (
    leadingText.length > 0 &&
    (!leadingText.startsWith("@") || !/\s$/u.test(leadingText))
  ) {
    return null;
  }

  return {
    leadingText,
    query,
    replaceFromOffset: slashIndex,
    replaceToOffset: cursorPosition + suffix.length,
  };
}

export function resolveLeadingAgentMentionPubkeys(
  leadingText: string,
  candidates: readonly AgentMentionCandidate[],
): string[] {
  let remaining = leadingText;
  const pubkeys: string[] = [];
  const seen = new Set<string>();
  const names = [
    ...new Set(candidates.map((candidate) => candidate.displayName)),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  while (remaining.startsWith("@")) {
    const lowerRemaining = remaining.toLowerCase();
    const name = names.find((candidate) => {
      const token = `@${candidate.toLowerCase()}`;
      return (
        lowerRemaining.startsWith(token) &&
        (remaining.length === token.length ||
          /\s/u.test(remaining.charAt(token.length)))
      );
    });
    if (!name) return [];

    for (const candidate of candidates) {
      if (candidate.displayName.toLowerCase() !== name.toLowerCase()) continue;
      const normalized = candidate.pubkey.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        pubkeys.push(normalized);
      }
    }

    remaining = remaining.slice(name.length + 1);
    const whitespace = remaining.match(/^\s+/u)?.[0] ?? "";
    if (!whitespace) return [];
    remaining = remaining.slice(whitespace.length);
  }

  return remaining.length === 0 ? pubkeys : [];
}

export function buildSlashCommandInsertText(
  suggestion: SlashCommandSuggestion,
  hasLeadingAgentMention: boolean,
): string {
  const command = `/${suggestion.name} `;
  return hasLeadingAgentMention
    ? command
    : `@${suggestion.agentDisplayName} ${command}`;
}

function commandRank(
  name: string,
  description: string | null,
  query: string,
): number | null {
  if (!query) return 0;
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerName.startsWith(lowerQuery)) return 0;
  if (lowerName.split(/[-_:]/u).some((part) => part.startsWith(lowerQuery))) {
    return 1_000;
  }
  const infix = lowerName.indexOf(lowerQuery);
  if (infix >= 0) return 2_000 + infix;
  const subsequence = subsequenceRank(lowerName, lowerQuery);
  if (subsequence !== null) return 3_000 + subsequence;
  const lowerDescription = description?.toLowerCase() ?? "";
  const descriptionInfix = lowerDescription.indexOf(lowerQuery);
  if (descriptionInfix >= 0) return 4_000 + descriptionInfix;
  const descriptionSubsequence = subsequenceRank(lowerDescription, lowerQuery);
  if (descriptionSubsequence !== null) return 5_000 + descriptionSubsequence;
  return null;
}

function subsequenceRank(value: string, query: string): number | null {
  let queryIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (
    let index = 0;
    index < value.length && queryIndex < query.length;
    index += 1
  ) {
    if (value[index] !== query[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = index;
    lastMatch = index;
    queryIndex += 1;
  }
  return queryIndex === query.length
    ? Math.max(0, lastMatch - firstMatch + 1 - query.length) + firstMatch
    : null;
}

export function buildSlashCommandGroups({
  catalog,
  providers,
  query,
  selectedAgentPubkeys,
}: {
  catalog: AgentCommandCatalog;
  providers: readonly SlashCommandProvider[];
  query: string;
  selectedAgentPubkeys: readonly string[] | null;
}): SlashCommandGroup[] {
  return buildSlashCommandMenu({
    catalog,
    providers,
    query,
    selectedAgentPubkeys,
  }).groups.slice();
}

export function buildSlashCommandMenu({
  catalog,
  providers,
  query,
  selectedAgentPubkeys,
}: {
  catalog: AgentCommandCatalog;
  providers: readonly SlashCommandProvider[];
  query: string;
  selectedAgentPubkeys: readonly string[] | null;
}): SlashCommandMenu {
  const selected = selectedAgentPubkeys
    ? new Set(selectedAgentPubkeys.map((pubkey) => pubkey.toLowerCase()))
    : null;
  const eligibleProviders = providers.filter(
    (provider) => !selected || selected.has(provider.pubkey.toLowerCase()),
  );
  const totalCommandCount = eligibleProviders.reduce(
    (total, provider) =>
      total +
      (catalog.get(provider.pubkey.toLowerCase())?.commands.length ?? 0),
    0,
  );
  const groups: SlashCommandGroup[] = [];
  let displayedCount = 0;
  let totalMatchCount = 0;
  let remainingMatchSlots = query ? SLASH_COMMAND_MATCH_LIMIT : Infinity;

  for (const provider of eligibleProviders) {
    const entries = (catalog.get(provider.pubkey.toLowerCase())?.commands ?? [])
      .map((command, publisherIndex) => ({
        command,
        publisherIndex,
        rank: commandRank(command.name, command.description, query),
      }))
      .filter(
        (entry): entry is typeof entry & { rank: number } =>
          entry.rank !== null,
      );
    totalMatchCount += entries.length;
    if (query) {
      entries.sort(
        (left, right) =>
          left.rank - right.rank || left.publisherIndex - right.publisherIndex,
      );
    }
    const visible = entries.slice(
      0,
      query
        ? Math.max(0, remainingMatchSlots)
        : SLASH_COMMAND_EMPTY_LIMIT_PER_AGENT,
    );
    if (query) remainingMatchSlots -= visible.length;
    displayedCount += visible.length;
    if (visible.length === 0) continue;
    groups.push({
      agentDisplayName: provider.displayName,
      agentPubkey: provider.pubkey,
      commands: visible.map(({ command }) => ({
        agentDisplayName: provider.displayName,
        agentPubkey: provider.pubkey,
        description: command.description,
        name: command.name,
      })),
    });
  }

  return { displayedCount, groups, totalCommandCount, totalMatchCount };
}
