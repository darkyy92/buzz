import assert from "node:assert/strict";
import test from "node:test";

import { persistThreadTitle } from "./threadTitlePersistence.ts";

test("rename waits for authoritative history without manufacturing a local event version", async () => {
  const calls = [];
  const title = await persistThreadTitle(
    {
      channelId: "general",
      rootId: "a".repeat(64),
      title: "  Launch   plan  ",
    },
    {
      async persist(channelId, rootId, normalizedTitle) {
        calls.push(["persist", channelId, rootId, normalizedTitle]);
      },
      async refresh() {
        calls.push(["refresh"]);
      },
    },
  );

  assert.equal(title, "Launch plan");
  assert.deepEqual(calls, [
    ["persist", "general", "a".repeat(64), "Launch plan"],
    ["refresh"],
  ]);
});
