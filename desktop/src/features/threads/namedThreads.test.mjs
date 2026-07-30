import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNamedThreadActivity,
  deriveFallbackThreadTitle,
  namedThreadsForChannel,
  parseNamedThreadTitleEdit,
  reduceNamedThreadTitleEdits,
  resolveThreadDisplayTitle,
  retainNamedThreadsWithRootEvents,
  upsertNamedThreadTitleStateEvent,
} from "./namedThreads.ts";

const ROOT_1 = "1".repeat(64);

function event({
  createdAt,
  id,
  kind = 40009,
  pubkey = "alice",
  tags,
  content = "body",
}) {
  return {
    id,
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content,
    sig: "",
  };
}

function titleEdit(id, createdAt, title, channelId = "channel-1") {
  return event({
    id,
    createdAt,
    tags: [
      ["h", channelId],
      ["e", ROOT_1],
      ["subject", title],
      ["t", "buzz-thread-title"],
    ],
    content: "",
  });
}

test("fallback title uses the first non-empty line and caps it at 80 characters", () => {
  assert.equal(
    deriveFallbackThreadTitle("\n  ## Release planning  \nmore"),
    "Release planning",
  );
  assert.equal(deriveFallbackThreadTitle(""), "Untitled thread");
  assert.equal(deriveFallbackThreadTitle("x".repeat(90)).length, 80);
});

test("only marked title protocol events become named threads", () => {
  const valid = titleEdit("edit-1", 10, "Release notes");
  assert.equal(parseNamedThreadTitleEdit(valid)?.title, "Release notes");
  assert.equal(
    parseNamedThreadTitleEdit({ ...valid, kind: 40003 })?.title,
    "Release notes",
    "legacy SDK combined edits remain compatible",
  );
  assert.equal(
    parseNamedThreadTitleEdit({
      ...valid,
      tags: valid.tags.filter((tag) => tag[0] !== "t"),
    }),
    null,
  );
  assert.equal(parseNamedThreadTitleEdit({ ...valid, kind: 40010 }), null);
});

test("title parser fails closed on ambiguous targets and malformed protocol shapes", () => {
  const valid = titleEdit("edit-1", 10, "Release notes");
  assert.equal(
    parseNamedThreadTitleEdit({
      ...valid,
      tags: [...valid.tags, ["e", "2".repeat(64)]],
    }),
    null,
  );
  assert.equal(
    parseNamedThreadTitleEdit({ ...valid, content: "must stay metadata-only" }),
    null,
  );
  assert.equal(
    parseNamedThreadTitleEdit({
      ...valid,
      tags: [...valid.tags, ["subject", "second"]],
    }),
    null,
  );
  assert.equal(
    parseNamedThreadTitleEdit({
      ...valid,
      tags: valid.tags.map((tag) =>
        tag[0] === "subject" ? ["subject", "x".repeat(81)] : tag,
      ),
    }),
    null,
  );
});

test("empty subject crosses the protocol boundary as a valid clear", () => {
  const clear = parseNamedThreadTitleEdit(titleEdit("edit-clear", 20, ""));
  assert.ok(clear);
  assert.equal(clear.title, "");
  assert.deepEqual(
    reduceNamedThreadTitleEdits([
      titleEdit("edit-set", 10, "Release notes"),
      titleEdit("edit-clear", 20, ""),
    ]),
    [],
  );
});

test("a live clear before initial history load persists as a hidden tombstone", () => {
  const states = upsertNamedThreadTitleStateEvent(
    [],
    titleEdit("clear-live", 20, ""),
  );

  assert.equal(states.length, 1);
  assert.equal(states[0].title, "");
  assert.deepEqual(namedThreadsForChannel(states, "channel-1"), []);
});

test("a clear tombstone overrides a stale root subject and falls back to the body", () => {
  assert.equal(
    resolveThreadDisplayTitle(
      "Body fallback",
      [["subject", "Stale root subject"]],
      { title: "" },
    ),
    "Body fallback",
  );
});

test("only true supported roots survive named-thread validation", () => {
  const [thread] = reduceNamedThreadTitleEdits([
    titleEdit("edit-1", 10, "Release notes"),
  ]);
  const root = event({
    id: ROOT_1,
    createdAt: 1,
    kind: 9,
    content: "root",
    tags: [["h", "channel-1"]],
  });
  assert.deepEqual(retainNamedThreadsWithRootEvents([thread], [root]), [
    thread,
  ]);
  assert.deepEqual(
    retainNamedThreadsWithRootEvents(
      [thread],
      [
        {
          ...root,
          tags: [
            ["h", "channel-1"],
            ["e", "2".repeat(64), "", "reply"],
          ],
        },
      ],
    ),
    [],
  );
  assert.deepEqual(
    retainNamedThreadsWithRootEvents([thread], [{ ...root, kind: 45003 }]),
    [],
  );
});

test("latest title wins and a later empty subject clears the explicit thread", () => {
  assert.deepEqual(
    reduceNamedThreadTitleEdits([
      titleEdit("edit-1", 10, "Old"),
      titleEdit("edit-2", 20, "New"),
    ]).map((thread) => thread.title),
    ["New"],
  );
  assert.deepEqual(
    reduceNamedThreadTitleEdits([
      titleEdit("edit-1", 10, "Old"),
      titleEdit("edit-2", 20, ""),
    ]),
    [],
  );
});

test("title resolution breaks equal timestamps deterministically by event id", () => {
  const titles = reduceNamedThreadTitleEdits([
    { ...titleEdit("a", 20, "Legacy"), kind: 40003 },
    titleEdit("b", 20, "Protocol title"),
  ]);
  assert.equal(titles[0].title, "Protocol title");
  assert.equal(titles[0].titleEventId, "b");
});

test("reply activity tracks recency and the newest incoming unread candidate", () => {
  const [thread] = reduceNamedThreadTitleEdits([
    titleEdit("edit-1", 10, "Release notes"),
  ]);
  const next = applyNamedThreadActivity(
    [thread],
    [
      event({
        id: "reply-1",
        createdAt: 20,
        kind: 9,
        pubkey: "bob",
        tags: [
          ["h", "channel-1"],
          ["e", ROOT_1, "", "root"],
        ],
      }),
      event({
        id: "reply-2",
        createdAt: 30,
        kind: 40002,
        pubkey: "alice",
        tags: [
          ["h", "channel-1"],
          ["e", ROOT_1, "", "root"],
        ],
      }),
    ],
    "alice",
  );

  assert.equal(next[0].lastReplyAt, 30);
  assert.equal(next[0].lastIncomingReplyAt, 20);
  assert.equal(next[0].lastActivityAt, 30);
});

test("sidebar projection is recent-first and bounded to twelve rows", () => {
  const threads = Array.from({ length: 14 }, (_, index) => ({
    channelId: "channel-1",
    rootId: `root-${index}`,
    title: `Thread ${index}`,
    titleEventId: `edit-${index}`,
    titleUpdatedAt: index,
    lastReplyAt: null,
    lastIncomingReplyAt: null,
    lastActivityAt: index,
  }));

  const visible = namedThreadsForChannel(threads, "channel-1");
  assert.equal(visible.length, 12);
  assert.equal(visible[0].rootId, "root-13");
  assert.equal(visible[11].rootId, "root-2");
});
