import * as React from "react";
import { verifyEvent } from "nostr-tools/pure";

import type {
  AgentCommand,
  AgentCommandCatalog,
} from "@/features/agents/agentCommandCatalog";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_APP_DATA } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

export const AGENT_COMMAND_CATALOG_D_TAG = "buzz:agent-commands:v1";
export const AGENT_COMMAND_CATALOG_T_TAG = "buzz-agent-commands";
export const AGENT_COMMAND_CATALOG_VERSION = 1;

const MAX_COMMANDS = 512;
const MAX_NAME_BYTES = 128;
const MAX_DESCRIPTION_CHARACTERS = 80;
const MAX_CONTENT_BYTES = 64 * 1024;
const EMPTY_CATALOG: AgentCommandCatalog = new Map();
const utf8 = new TextEncoder();

type ParsedPublication = {
  agentPubkey: string;
  commands: readonly AgentCommand[];
  createdAt: number;
  eventId: string;
};

type NativeCatalogEntry = {
  commands: readonly AgentCommand[];
  createdAt: number;
  eventId: string;
};

type NativeCatalog = ReadonlyMap<string, NativeCatalogEntry>;

function hasExactTag(event: RelayEvent, name: string, value?: string): boolean {
  return event.tags.some(
    (tag) =>
      tag.length === (value === undefined ? 1 : 2) &&
      tag[0] === name &&
      (value === undefined || tag[1] === value),
  );
}

function parseCommands(content: string): readonly AgentCommand[] | null {
  if (utf8.encode(content).length > MAX_CONTENT_BYTES) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    record.version !== AGENT_COMMAND_CATALOG_VERSION ||
    !Array.isArray(record.commands) ||
    record.commands.length > MAX_COMMANDS ||
    Object.keys(record).some((key) => key !== "version" && key !== "commands")
  ) {
    return null;
  }

  const commands: AgentCommand[] = [];
  const names = new Set<string>();
  for (const value of record.commands) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const command = value as Record<string, unknown>;
    if (
      typeof command.name !== "string" ||
      Object.keys(command).some(
        (key) => key !== "name" && key !== "description",
      )
    ) {
      return null;
    }
    const name = command.name.trim();
    const description =
      command.description === undefined || command.description === null
        ? null
        : typeof command.description === "string"
          ? command.description.trim() || null
          : undefined;
    const nameKey = name.toLowerCase();
    if (
      !name ||
      name !== command.name ||
      utf8.encode(name).length > MAX_NAME_BYTES ||
      name.startsWith("/") ||
      /\s|\//u.test(name) ||
      description === undefined ||
      (description !== null &&
        [...description].length > MAX_DESCRIPTION_CHARACTERS) ||
      names.has(nameKey)
    ) {
      return null;
    }
    names.add(nameKey);
    commands.push({ name, description });
  }
  return commands;
}

export function parseAgentCommandCatalogEvent(
  event: RelayEvent,
  allowedAgentPubkeys: ReadonlySet<string>,
): ParsedPublication | null {
  const agentPubkey = normalizePubkey(event.pubkey);
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  if (
    event.kind !== KIND_APP_DATA ||
    !allowedAgentPubkeys.has(agentPubkey) ||
    dTags.length !== 1 ||
    dTags[0].length !== 2 ||
    dTags[0][1] !== AGENT_COMMAND_CATALOG_D_TAG ||
    !hasExactTag(event, "t", AGENT_COMMAND_CATALOG_T_TAG) ||
    !hasExactTag(event, "-")
  ) {
    return null;
  }
  try {
    if (
      !verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
      })
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const commands = parseCommands(event.content);
  return commands
    ? {
        agentPubkey,
        commands,
        createdAt: event.created_at,
        eventId: event.id,
      }
    : null;
}

function applyPublication(
  catalog: NativeCatalog,
  publication: ParsedPublication,
): NativeCatalog {
  const current = catalog.get(publication.agentPubkey);
  if (
    current &&
    (current.createdAt > publication.createdAt ||
      (current.createdAt === publication.createdAt &&
        current.eventId >= publication.eventId))
  ) {
    return catalog;
  }
  const next = new Map(catalog);
  next.set(publication.agentPubkey, {
    commands: publication.commands,
    createdAt: publication.createdAt,
    eventId: publication.eventId,
  });
  return next;
}

export function buildRelayAgentCommandCatalog(
  events: readonly RelayEvent[],
  agentPubkeys: readonly string[],
): AgentCommandCatalog {
  const allowed = new Set(agentPubkeys.map(normalizePubkey));
  let native: NativeCatalog = new Map();
  for (const event of events) {
    const publication = parseAgentCommandCatalogEvent(event, allowed);
    if (publication) native = applyPublication(native, publication);
  }
  return new Map(
    [...native].map(([pubkey, entry]) => [
      pubkey,
      {
        commands: entry.commands,
        seq: entry.createdAt,
        timestamp: new Date(entry.createdAt * 1_000).toISOString(),
      },
    ]),
  );
}

export function mergeAgentCommandCatalogs(
  primary: AgentCommandCatalog,
  secondary: AgentCommandCatalog,
): AgentCommandCatalog {
  const merged = new Map(primary);
  for (const [pubkey, secondaryEntry] of secondary) {
    const primaryEntry = primary.get(pubkey);
    if (!primaryEntry) {
      merged.set(pubkey, secondaryEntry);
      continue;
    }
    const names = new Set(
      primaryEntry.commands.map((command) => command.name.toLowerCase()),
    );
    merged.set(pubkey, {
      ...primaryEntry,
      commands: [
        ...primaryEntry.commands,
        ...secondaryEntry.commands.filter(
          (command) => !names.has(command.name.toLowerCase()),
        ),
      ],
    });
  }
  return merged;
}

export function useRelayAgentCommandCatalog(
  agentPubkeys: readonly string[],
  relayUrl: string | null,
): AgentCommandCatalog {
  const normalizedAgents = React.useMemo(
    () => [...new Set(agentPubkeys.map(normalizePubkey))].sort(),
    [agentPubkeys],
  );
  const scope = JSON.stringify([relayUrl, normalizedAgents]);
  const [state, setState] = React.useState<{
    catalog: NativeCatalog;
    scope: string;
  }>({ catalog: new Map(), scope });

  React.useEffect(() => {
    if (!relayUrl || normalizedAgents.length === 0) return;
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    const allowed = new Set(normalizedAgents);
    const filter = {
      kinds: [KIND_APP_DATA],
      authors: normalizedAgents,
      "#d": [AGENT_COMMAND_CATALOG_D_TAG],
      limit: normalizedAgents.length,
    };
    const accept = (event: RelayEvent) => {
      const publication = parseAgentCommandCatalogEvent(event, allowed);
      if (!publication || disposed) return;
      setState((current) => ({
        scope,
        catalog: applyPublication(
          current.scope === scope ? current.catalog : new Map(),
          publication,
        ),
      }));
    };

    setState({ catalog: new Map(), scope });
    void (async () => {
      try {
        const dispose = await relayClient.subscribeLive(
          { ...filter, limit: 0 },
          accept,
        );
        if (disposed) void dispose();
        else unsubscribe = dispose;
      } catch {
        // History can still populate the catalog if live setup races reconnect.
      }
      try {
        const events = await relayClient.fetchEvents(filter);
        for (const event of events) accept(event);
      } catch {
        // The ACP observer catalog remains available while the relay recovers.
      }
    })();
    return () => {
      disposed = true;
      if (unsubscribe) void unsubscribe();
    };
  }, [normalizedAgents, relayUrl, scope]);

  return React.useMemo(
    () =>
      state.scope === scope
        ? new Map(
            [...state.catalog].map(([pubkey, entry]) => [
              pubkey,
              {
                commands: entry.commands,
                seq: entry.createdAt,
                timestamp: new Date(entry.createdAt * 1_000).toISOString(),
              },
            ]),
          )
        : EMPTY_CATALOG,
    [scope, state],
  );
}
