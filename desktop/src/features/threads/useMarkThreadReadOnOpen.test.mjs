import assert from "node:assert/strict";
import test from "node:test";

import { resolveThreadReadFrontier } from "./useMarkThreadReadOnOpen.ts";

function head(id = "root", createdAt = 10) {
  return { id, createdAt };
}

function reply(createdAt, lastReplyAt = null) {
  return {
    message: { createdAt },
    summary: lastReplyAt === null ? null : { lastReplyAt },
  };
}

test("cached replies stay available but never mark while a refetch is unresolved", () => {
  const cachedReplies = [reply(20), reply(25, 30)];
  const frontier = resolveThreadReadFrontier({
    openedThreadHeadId: null,
    ready: false,
    replies: cachedReplies,
    threadHead: head(),
  });

  assert.equal(frontier, null);
  assert.equal(cachedReplies.length, 2);
  assert.equal(cachedReplies[1].summary.lastReplyAt, 30);
});

test("a failed initial fetch never creates a read frontier", () => {
  assert.equal(
    resolveThreadReadFrontier({
      openedThreadHeadId: null,
      ready: false,
      replies: [],
      threadHead: head(),
    }),
    null,
  );
});

test("a failed background fetch never changes an existing frontier", () => {
  assert.equal(
    resolveThreadReadFrontier({
      openedThreadHeadId: "root",
      ready: false,
      replies: [reply(40)],
      threadHead: head(),
    }),
    null,
  );
});

test("a resolved open marks the newest loaded activity exactly once", () => {
  const frontier = resolveThreadReadFrontier({
    openedThreadHeadId: null,
    ready: true,
    replies: [reply(20), reply(25, 30)],
    threadHead: head(),
  });

  assert.deepEqual(frontier, { rootId: "root", timestamp: 30 });
  assert.equal(
    resolveThreadReadFrontier({
      openedThreadHeadId: frontier.rootId,
      ready: true,
      replies: [reply(20), reply(25, 30)],
      threadHead: head(),
    }),
    null,
  );
});

test("a later live reply does not advance an already opened frontier", () => {
  assert.equal(
    resolveThreadReadFrontier({
      openedThreadHeadId: "root",
      ready: true,
      replies: [reply(20), reply(80)],
      threadHead: head(),
    }),
    null,
  );
});
