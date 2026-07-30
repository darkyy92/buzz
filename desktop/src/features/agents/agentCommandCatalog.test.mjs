import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  getAgentCommandCatalog,
  parseAvailableCommandsPayload,
  recordAvailableCommandsUpdate,
  resetAgentCommandCatalogForTests,
} from "./agentCommandCatalog.ts";

const OWNER = "aa".repeat(32);
const OTHER_OWNER = "bb".repeat(32);
const AGENT = "cc".repeat(32);
const RELAY = "wss://alpha.example";
const OTHER_RELAY = "wss://beta.example";

function installLocalStorage() {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      get length() {
        return values.size;
      },
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, String(value)),
    },
  };
}

describe("agent command catalog", () => {
  beforeEach(() => {
    installLocalStorage();
    resetAgentCommandCatalogForTests();
  });

  it("sanitizes, bounds, and deduplicates advertised commands", () => {
    const commands = parseAvailableCommandsPayload({
      commands: [
        { name: "/review", description: " Review changes " },
        { name: "REVIEW", description: "duplicate" },
        { name: "bad name" },
        { name: "deploy", description: 42 },
      ],
    });

    assert.deepEqual(commands, [
      { name: "review", description: "Review changes" },
      { name: "deploy", description: null },
    ]);
  });

  it("keeps all 464 live commands, caps descriptions, and rejects overflow", () => {
    const commands = Array.from({ length: 464 }, (_, index) => ({
      name: `command-${index}`,
      description: index === 0 ? "🧭".repeat(81) : "Description",
    }));
    const parsed = parseAvailableCommandsPayload({ commands });
    assert.equal(parsed?.length, 464);
    assert.equal([...parsed[0].description].length, 80);
    assert.equal(
      parseAvailableCommandsPayload({
        commands: Array.from({ length: 513 }, (_, index) => ({
          name: `command-${index}`,
        })),
      }),
      null,
    );
  });

  it("keeps the latest complete command list per owner and agent", () => {
    assert.equal(
      recordAvailableCommandsUpdate(OWNER, RELAY, AGENT, {
        seq: 8,
        timestamp: "2026-07-23T08:00:00Z",
        payload: { commands: [{ name: "review", description: "Review" }] },
      }),
      true,
    );
    assert.equal(
      recordAvailableCommandsUpdate(OWNER, RELAY, AGENT, {
        seq: 7,
        timestamp: "2026-07-23T07:00:00Z",
        payload: { commands: [{ name: "stale" }] },
      }),
      false,
    );

    assert.deepEqual(
      getAgentCommandCatalog(OWNER, RELAY).get(AGENT)?.commands,
      [{ name: "review", description: "Review" }],
    );
    assert.equal(getAgentCommandCatalog(OTHER_OWNER, RELAY).has(AGENT), false);
    assert.equal(getAgentCommandCatalog(OWNER, OTHER_RELAY).has(AGENT), false);
  });

  it("treats an empty update as authoritative removal of prior commands", () => {
    recordAvailableCommandsUpdate(OWNER, RELAY, AGENT, {
      seq: 1,
      timestamp: "2026-07-23T08:00:00Z",
      payload: { commands: [{ name: "review" }] },
    });
    recordAvailableCommandsUpdate(OWNER, RELAY, AGENT, {
      seq: 2,
      timestamp: "2026-07-23T08:01:00Z",
      payload: { commands: [] },
    });

    assert.deepEqual(
      getAgentCommandCatalog(OWNER, RELAY).get(AGENT)?.commands,
      [],
    );
  });

  it("hydrates a persisted owner-scoped catalog after restart", () => {
    recordAvailableCommandsUpdate(OWNER, RELAY, AGENT, {
      seq: 3,
      timestamp: "2026-07-23T08:00:00Z",
      payload: { commands: [{ name: "review" }] },
    });
    resetAgentCommandCatalogForTests();

    assert.deepEqual(
      getAgentCommandCatalog(OWNER, RELAY).get(AGENT)?.commands,
      [{ name: "review", description: null }],
    );
  });
});
