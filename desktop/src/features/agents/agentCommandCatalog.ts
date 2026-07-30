import { normalizePubkey } from "@/shared/lib/pubkey";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";
import { canonicalRelayUrl } from "./managedAgentRuntimeStatus";

const STORAGE_PREFIX = "buzz-agent-command-catalog.v2";
const MAX_COMMANDS_PER_AGENT = 512;
const MAX_COMMAND_NAME_LENGTH = 128;
const MAX_COMMAND_DESCRIPTION_LENGTH = 80;

export type AgentCommand = {
  name: string;
  description: string | null;
};

export type AgentCommandCatalogEntry = {
  commands: readonly AgentCommand[];
  seq: number;
  timestamp: string;
};

export type AgentCommandCatalog = ReadonlyMap<string, AgentCommandCatalogEntry>;

type PersistedCatalog = {
  version: 1;
  agents: Record<string, AgentCommandCatalogEntry>;
};

type AvailableCommandsEvent = {
  payload: unknown;
  seq: number;
  timestamp: string;
};

const EMPTY_CATALOG: AgentCommandCatalog = new Map();
const catalogByScope = new Map<string, AgentCommandCatalog>();
const hydratedScopes = new Set<string>();
const listeners = new Set<() => void>();

function normalizeRelayScope(relayUrl: string): string {
  return canonicalRelayUrl(relayUrl) ?? relayUrl.trim().toLowerCase();
}

function scopeKey(ownerPubkey: string, relayUrl: string): string {
  return JSON.stringify([
    normalizeRelayScope(relayUrl),
    normalizePubkey(ownerPubkey),
  ]);
}

function storageKey(ownerPubkey: string, relayUrl: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(normalizeRelayScope(relayUrl))}:${normalizePubkey(ownerPubkey)}`;
}

function sanitizeCommand(value: unknown): AgentCommand | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") return null;

  const name = record.name.trim().replace(/^\/+/, "");
  if (
    name.length === 0 ||
    name.length > MAX_COMMAND_NAME_LENGTH ||
    /\s|\//u.test(name)
  ) {
    return null;
  }

  const description =
    typeof record.description === "string"
      ? [...record.description.trim()]
          .slice(0, MAX_COMMAND_DESCRIPTION_LENGTH)
          .join("") || null
      : null;
  return { name, description };
}

export function parseAvailableCommandsPayload(
  payload: unknown,
): readonly AgentCommand[] | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const commands = (payload as Record<string, unknown>).commands;
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS_PER_AGENT) {
    return null;
  }

  const parsed: AgentCommand[] = [];
  const seen = new Set<string>();
  for (const value of commands) {
    const command = sanitizeCommand(value);
    if (!command) continue;
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(command);
  }
  return parsed;
}

function parseStoredCatalog(raw: string | null): AgentCommandCatalog {
  if (!raw) return EMPTY_CATALOG;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedCatalog>;
    if (
      parsed.version !== 1 ||
      !parsed.agents ||
      typeof parsed.agents !== "object"
    ) {
      return EMPTY_CATALOG;
    }
    const next = new Map<string, AgentCommandCatalogEntry>();
    for (const [pubkey, entry] of Object.entries(parsed.agents)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<AgentCommandCatalogEntry>;
      const commands = parseAvailableCommandsPayload({
        commands: candidate.commands,
      });
      if (
        commands === null ||
        typeof candidate.seq !== "number" ||
        !Number.isSafeInteger(candidate.seq) ||
        typeof candidate.timestamp !== "string"
      ) {
        continue;
      }
      next.set(normalizePubkey(pubkey), {
        commands,
        seq: candidate.seq,
        timestamp: candidate.timestamp,
      });
    }
    return next;
  } catch {
    return EMPTY_CATALOG;
  }
}

function hydrate(ownerPubkey: string, relayUrl: string): AgentCommandCatalog {
  const key = scopeKey(ownerPubkey, relayUrl);
  if (!hydratedScopes.has(key)) {
    const raw =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(storageKey(ownerPubkey, relayUrl));
    catalogByScope.set(key, parseStoredCatalog(raw));
    hydratedScopes.add(key);
  }
  return catalogByScope.get(key) ?? EMPTY_CATALOG;
}

function persist(
  ownerPubkey: string,
  relayUrl: string,
  catalog: AgentCommandCatalog,
): void {
  if (typeof window === "undefined") return;
  const agents = Object.fromEntries(catalog.entries());
  setLocalStorageItemWithRecovery(
    storageKey(ownerPubkey, relayUrl),
    JSON.stringify({ version: 1, agents } satisfies PersistedCatalog),
  );
}

function isNewer(
  incoming: Pick<AgentCommandCatalogEntry, "seq" | "timestamp">,
  current: AgentCommandCatalogEntry | undefined,
): boolean {
  if (!current) return true;
  const incomingTime = Date.parse(incoming.timestamp);
  const currentTime = Date.parse(current.timestamp);
  if (Number.isFinite(incomingTime) && Number.isFinite(currentTime)) {
    if (incomingTime !== currentTime) return incomingTime > currentTime;
  }
  return incoming.seq > current.seq;
}

export function recordAvailableCommandsUpdate(
  ownerPubkey: string,
  relayUrl: string,
  agentPubkey: string,
  event: AvailableCommandsEvent,
): boolean {
  const commands = parseAvailableCommandsPayload(event.payload);
  if (commands === null || !Number.isSafeInteger(event.seq)) return false;

  const agent = normalizePubkey(agentPubkey);
  const key = scopeKey(ownerPubkey, relayUrl);
  const current = hydrate(ownerPubkey, relayUrl);
  if (!isNewer(event, current.get(agent))) return false;

  const next = new Map(current);
  next.set(agent, {
    commands,
    seq: event.seq,
    timestamp: event.timestamp,
  });
  catalogByScope.set(key, next);
  persist(ownerPubkey, relayUrl, next);
  for (const listener of listeners) listener();
  return true;
}

export function getAgentCommandCatalog(
  ownerPubkey: string | null,
  relayUrl: string | null,
): AgentCommandCatalog {
  return ownerPubkey && relayUrl
    ? hydrate(ownerPubkey, relayUrl)
    : EMPTY_CATALOG;
}

export function subscribeAgentCommandCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetAgentCommandCatalog(): void {
  catalogByScope.clear();
  hydratedScopes.clear();
}

export function resetAgentCommandCatalogForTests(): void {
  resetAgentCommandCatalog();
  listeners.clear();
}
