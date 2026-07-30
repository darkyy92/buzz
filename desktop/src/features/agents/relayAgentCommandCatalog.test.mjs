import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  AGENT_COMMAND_CATALOG_D_TAG,
  AGENT_COMMAND_CATALOG_T_TAG,
  buildRelayAgentCommandCatalog,
  mergeAgentCommandCatalogs,
  parseAgentCommandCatalogEvent,
} from "./relayAgentCommandCatalog.ts";

const SECRET = new Uint8Array(32).fill(7);
const AGENT = getPublicKey(SECRET);
const OTHER_AGENT = "bb".repeat(32);

function event({
  commands = [{ name: "review", description: "Review changes" }],
  createdAt = 1_800_000_000,
  tags = [
    ["d", AGENT_COMMAND_CATALOG_D_TAG],
    ["t", AGENT_COMMAND_CATALOG_T_TAG],
    ["-"],
  ],
} = {}) {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: createdAt,
      tags,
      content: JSON.stringify({ version: 1, commands }),
    },
    SECRET,
  );
}

describe("relay agent command catalog", () => {
  it("accepts only signed, scoped, versioned agent publications", () => {
    const publication = event();
    assert.deepEqual(
      parseAgentCommandCatalogEvent(publication, new Set([AGENT]))?.commands,
      [{ name: "review", description: "Review changes" }],
    );
    assert.equal(
      parseAgentCommandCatalogEvent(publication, new Set([OTHER_AGENT])),
      null,
    );
    assert.equal(
      parseAgentCommandCatalogEvent(
        { ...publication, content: `${publication.content} ` },
        new Set([AGENT]),
      ),
      null,
      "tampered content must fail signature verification",
    );
    assert.equal(
      parseAgentCommandCatalogEvent(
        event({ tags: [["d", "another-app:v1"], ["-"]] }),
        new Set([AGENT]),
      ),
      null,
    );
  });

  it("rejects malformed catalogs as a whole and accepts empty clears", () => {
    assert.equal(
      parseAgentCommandCatalogEvent(
        event({ commands: [{ name: "/review" }] }),
        new Set([AGENT]),
      ),
      null,
    );
    assert.deepEqual(
      parseAgentCommandCatalogEvent(event({ commands: [] }), new Set([AGENT]))
        ?.commands,
      [],
    );
  });

  it("keeps 464 commands and rejects oversized or overlong catalogs", () => {
    const liveCatalog = Array.from({ length: 464 }, (_, index) => ({
      name: `command-${index}`,
      description: "x".repeat(80),
    }));
    assert.equal(
      parseAgentCommandCatalogEvent(
        event({ commands: liveCatalog }),
        new Set([AGENT]),
      )?.commands.length,
      464,
    );
    assert.equal(
      parseAgentCommandCatalogEvent(
        event({
          commands: Array.from({ length: 513 }, (_, index) => ({
            name: `command-${index}`,
          })),
        }),
        new Set([AGENT]),
      ),
      null,
    );
    assert.equal(
      parseAgentCommandCatalogEvent(
        event({
          commands: [{ name: "review", description: "🧭".repeat(81) }],
        }),
        new Set([AGENT]),
      ),
      null,
    );
  });

  it("keeps the newest event per agent independent of fetch order", () => {
    const older = event({
      commands: [{ name: "old" }],
      createdAt: 1_800_000_000,
    });
    const newer = event({
      commands: [{ name: "new" }],
      createdAt: 1_800_000_001,
    });
    const catalog = buildRelayAgentCommandCatalog([newer, older], [AGENT]);
    assert.deepEqual(catalog.get(AGENT)?.commands, [
      { name: "new", description: null },
    ]);
  });

  it("merges native commands behind live ACP commands without duplicates", () => {
    const acp = new Map([
      [
        AGENT,
        {
          commands: [{ name: "review", description: "Live description" }],
          seq: 3,
          timestamp: "2026-07-30T08:00:00Z",
        },
      ],
    ]);
    const native = buildRelayAgentCommandCatalog(
      [
        event({
          commands: [
            { name: "review", description: "Relay description" },
            { name: "goal", description: "Set a goal" },
          ],
        }),
      ],
      [AGENT],
    );
    assert.deepEqual(
      mergeAgentCommandCatalogs(acp, native).get(AGENT)?.commands,
      [
        { name: "review", description: "Live description" },
        { name: "goal", description: "Set a goal" },
      ],
    );
  });
});
