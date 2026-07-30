import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSlashCommandMenu,
  buildSlashCommandGroups,
  buildSlashCommandInsertText,
  detectSlashCommandQuery,
  getSlashCommandFooterMessage,
  resolveLeadingAgentMentionPubkeys,
} from "./slashCommandAutocomplete.ts";

const ALPHA = "aa".repeat(32);
const BETA = "bb".repeat(32);
const catalog = new Map([
  [
    ALPHA,
    {
      seq: 1,
      timestamp: "2026-07-23T08:00:00Z",
      commands: [
        { name: "review", description: "Review the current changes" },
        { name: "deploy", description: "Ship to production" },
      ],
    },
  ],
  [
    BETA,
    {
      seq: 1,
      timestamp: "2026-07-23T08:00:00Z",
      commands: [{ name: "review", description: "Independent review" }],
    },
  ],
]);
const providers = [
  { pubkey: ALPHA, displayName: "Alpha" },
  { pubkey: BETA, displayName: "Beta" },
];

describe("slash command autocomplete", () => {
  it("detects a slash at message start and after leading agent mentions", () => {
    assert.deepEqual(detectSlashCommandQuery("/rev", 4), {
      leadingText: "",
      query: "rev",
      replaceFromOffset: 0,
      replaceToOffset: 4,
    });
    assert.deepEqual(detectSlashCommandQuery("@Alpha /dep", 11), {
      leadingText: "@Alpha ",
      query: "dep",
      replaceFromOffset: 7,
      replaceToOffset: 11,
    });
  });

  it("resolves selected or manually typed leading member-agent mentions", () => {
    assert.deepEqual(
      resolveLeadingAgentMentionPubkeys("@Alpha ", [
        { displayName: "Alpha", pubkey: ALPHA },
      ]),
      [ALPHA],
    );
    assert.deepEqual(
      resolveLeadingAgentMentionPubkeys("@Alpha @Beta ", [
        { displayName: "Alpha", pubkey: ALPHA },
        { displayName: "Beta", pubkey: BETA },
      ]),
      [ALPHA, BETA],
    );
    assert.deepEqual(
      resolveLeadingAgentMentionPubkeys("@Alpha hello ", [
        { displayName: "Alpha", pubkey: ALPHA },
      ]),
      [],
    );
  });

  it("does not trigger for inline paths, arguments, or multi-line text", () => {
    assert.equal(detectSlashCommandQuery("please /review", 14), null);
    assert.equal(detectSlashCommandQuery("/review now", 11), null);
    assert.equal(detectSlashCommandQuery("hello\n/review", 13), null);
    assert.equal(detectSlashCommandQuery("https://example.com", 19), null);
    assert.equal(detectSlashCommandQuery("`/review`", 8), null);
    assert.equal(detectSlashCommandQuery(":smile: /review", 15), null);
    assert.equal(detectSlashCommandQuery("#general /review", 16), null);
  });

  it("replaces the complete command token when the cursor is in its middle", () => {
    assert.deepEqual(detectSlashCommandQuery("@Alpha /deploy later", 10), {
      leadingText: "@Alpha ",
      query: "de",
      replaceFromOffset: 7,
      replaceToOffset: 14,
    });
  });

  it("routes commands chosen at message start through the provider mention", () => {
    const [group] = buildSlashCommandGroups({
      catalog,
      providers: [providers[0]],
      query: "rev",
      selectedAgentPubkeys: null,
    });
    const [suggestion] = group.commands;

    assert.equal(
      buildSlashCommandInsertText(suggestion, false),
      "@Alpha /review ",
    );
    assert.equal(buildSlashCommandInsertText(suggestion, true), "/review ");
  });

  it("groups duplicate command names by provider and narrows to mentions", () => {
    const all = buildSlashCommandGroups({
      catalog,
      providers,
      query: "rev",
      selectedAgentPubkeys: null,
    });
    assert.deepEqual(
      all.map((group) => [group.agentDisplayName, group.commands[0].name]),
      [
        ["Alpha", "review"],
        ["Beta", "review"],
      ],
    );

    const mentioned = buildSlashCommandGroups({
      catalog,
      providers,
      query: "",
      selectedAgentPubkeys: [BETA],
    });
    assert.deepEqual(
      mentioned.map((group) => group.agentPubkey),
      [BETA],
    );
  });

  it("ranks name prefixes before infix and description matches", () => {
    const rankedCatalog = new Map([
      [
        ALPHA,
        {
          seq: 1,
          timestamp: "2026-07-23T08:00:00Z",
          commands: [
            { name: "preview", description: null },
            { name: "review", description: null },
            { name: "inspect", description: "review changes" },
          ],
        },
      ],
    ]);
    const [group] = buildSlashCommandGroups({
      catalog: rankedCatalog,
      providers: [providers[0]],
      query: "rev",
      selectedAgentPubkeys: null,
    });
    assert.deepEqual(
      group.commands.map((command) => command.name),
      ["review", "preview", "inspect"],
    );
  });

  it("fuzzy-matches ordered characters after stronger name matches", () => {
    const fuzzyCatalog = new Map([
      [
        ALPHA,
        {
          seq: 1,
          timestamp: "2026-07-23T08:00:00Z",
          commands: [
            { name: "deploy-preview", description: null },
            { name: "dependency-review", description: null },
          ],
        },
      ],
    ]);
    const [group] = buildSlashCommandGroups({
      catalog: fuzzyCatalog,
      providers: [providers[0]],
      query: "dprv",
      selectedAgentPubkeys: null,
    });
    assert.deepEqual(
      group.commands.map((command) => command.name),
      ["deploy-preview", "dependency-review"],
    );
  });

  it("keeps the full catalog searchable while bounding rendered rows", () => {
    const largeCatalog = new Map([
      [
        ALPHA,
        {
          seq: 1,
          timestamp: "2026-07-30T08:00:00Z",
          commands: Array.from({ length: 232 }, (_, index) => ({
            name: `alpha-command-${index}`,
            description: null,
          })),
        },
      ],
      [
        BETA,
        {
          seq: 1,
          timestamp: "2026-07-30T08:00:00Z",
          commands: Array.from({ length: 232 }, (_, index) => ({
            name: `beta-command-${index}`,
            description: null,
          })),
        },
      ],
    ]);
    const initial = buildSlashCommandMenu({
      catalog: largeCatalog,
      providers,
      query: "",
      selectedAgentPubkeys: null,
    });
    assert.equal(initial.totalCommandCount, 464);
    assert.equal(initial.totalMatchCount, 464);
    assert.equal(initial.displayedCount, 24);
    assert.deepEqual(
      initial.groups.map((group) => group.commands.length),
      [12, 12],
    );
    assert.deepEqual(
      initial.groups[0].commands.slice(0, 2).map((command) => command.name),
      ["alpha-command-0", "alpha-command-1"],
      "empty-query suggestions preserve publisher order",
    );
    assert.equal(
      getSlashCommandFooterMessage(initial, ""),
      "Type to search all 464 commands",
    );

    const searched = buildSlashCommandMenu({
      catalog: largeCatalog,
      providers,
      query: "command",
      selectedAgentPubkeys: null,
    });
    assert.equal(searched.totalCommandCount, 464);
    assert.equal(searched.totalMatchCount, 464);
    assert.equal(searched.displayedCount, 50);
    assert.equal(
      getSlashCommandFooterMessage(searched, "command"),
      "Showing 50 of 464 matches. Refine your search.",
    );
  });
});
