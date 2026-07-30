import assert from "node:assert/strict";
import test from "node:test";

import { latestTopLevelChannelMessage } from "./latestTopLevelChannelMessage.ts";

const CHANNEL_ID = "general";
const ROOT_ID = "a".repeat(64);

function event({ createdAt, id, kind = 40002, tags = [] }) {
  return {
    id,
    pubkey: "b".repeat(64),
    created_at: createdAt,
    kind,
    tags: [["h", CHANNEL_ID], ...tags],
    content: "",
    sig: "",
  };
}

test("thread-title metadata never advances the top-level channel read frontier", () => {
  const topLevel = event({ createdAt: 10, id: ROOT_ID });
  const reply = event({
    createdAt: 20,
    id: "c".repeat(64),
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["e", ROOT_ID, "", "reply"],
    ],
  });
  const remoteRename = event({
    createdAt: 30,
    id: "d".repeat(64),
    kind: 40009,
    tags: [
      ["e", ROOT_ID, "", "root"],
      ["subject", "Remote launch plan"],
      ["t", "buzz-thread-title"],
    ],
  });

  assert.equal(
    latestTopLevelChannelMessage([topLevel, reply, remoteRename])?.id,
    ROOT_ID,
  );
});

test("the newest visible top-level message still advances the read frontier", () => {
  const earlier = event({ createdAt: 10, id: ROOT_ID });
  const later = event({ createdAt: 40, id: "e".repeat(64) });

  assert.equal(latestTopLevelChannelMessage([earlier, later])?.id, later.id);
});
