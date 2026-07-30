import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNamedThreadSnapshotActivity,
  fetchAllNamedThreadArchivedEvents,
  fetchAllNamedThreadRelayEvents,
  loadNamedThreadsForChannel,
  loadNamedThreadsForChannels,
  namedThreadActivityTargetKey,
  preserveNewerNamedThreadActivity,
} from "./namedThreadLoading.ts";
import { namedThreadsForChannel } from "./namedThreads.ts";

const GENERAL_ROOT = "a".repeat(64);
const QUIET_ROOT = "b".repeat(64);

function event({
  channelId,
  content = "",
  createdAt,
  id,
  kind,
  pubkey = "alice",
  rootId,
  title,
}) {
  const tags = [["h", channelId]];
  if (rootId) tags.push(["e", rootId, "", "root"]);
  if (title !== undefined) {
    tags.push(["subject", title], ["t", "buzz-thread-title"]);
  }
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

function titleEvent(channelId, rootId, title, createdAt, id) {
  return event({
    channelId,
    createdAt,
    id,
    kind: 40009,
    rootId,
    title,
  });
}

function namedThread(overrides = {}) {
  return {
    channelId: "general",
    rootId: GENERAL_ROOT,
    title: "Launch plan",
    titleEventId: "title",
    titleUpdatedAt: 10,
    lastReplyAt: null,
    lastIncomingReplyAt: null,
    lastActivityAt: 10,
    ...overrides,
  };
}

test("activity target key stays stable across title and reply state changes", () => {
  const initial = namedThreadActivityTargetKey([namedThread()]);
  const updated = namedThreadActivityTargetKey([
    namedThread({
      title: "Remote rename",
      titleEventId: "new-title",
      titleUpdatedAt: 20,
      lastReplyAt: 30,
      lastIncomingReplyAt: 30,
      lastActivityAt: 30,
    }),
  ]);

  assert.equal(updated, initial);
});

test("live activity updates snapshot threads without losing channel authority", () => {
  const snapshot = {
    threads: [namedThread()],
    authoritativeChannelIds: ["general"],
    invalidRootStates: [],
  };
  const reply = event({
    channelId: "general",
    createdAt: 50,
    id: "reply",
    kind: 9,
    pubkey: "alice",
    rootId: GENERAL_ROOT,
  });

  const updated = applyNamedThreadSnapshotActivity(snapshot, [reply], "me");

  assert.equal(updated.threads[0].lastIncomingReplyAt, 50);
  assert.deepEqual(updated.authoritativeChannelIds, ["general"]);
});

test("stale refetch cannot erase a newer live incoming-reply frontier", () => {
  const [merged] = preserveNewerNamedThreadActivity(
    [
      namedThread({
        lastReplyAt: 50,
        lastIncomingReplyAt: 50,
        lastActivityAt: 50,
      }),
    ],
    [
      namedThread({
        lastReplyAt: 20,
        lastIncomingReplyAt: 20,
        lastActivityAt: 20,
      }),
    ],
  );

  assert.equal(merged.lastReplyAt, 50);
  assert.equal(merged.lastIncomingReplyAt, 50);
  assert.equal(merged.lastActivityAt, 50);
});

test("stale refetch cannot overwrite a newer live rename", () => {
  const [merged] = preserveNewerNamedThreadActivity(
    [
      namedThread({
        title: "Live rename",
        titleEventId: "z",
        titleUpdatedAt: 30,
      }),
    ],
    [
      namedThread({
        title: "Stale history",
        titleEventId: "a",
        titleUpdatedAt: 20,
      }),
    ],
  );

  assert.equal(merged.title, "Live rename");
  assert.equal(merged.titleUpdatedAt, 30);
});

test("live clear tombstone survives stale refetch and a newer rename supersedes it", () => {
  const tombstone = namedThread({
    title: "",
    titleEventId: "z",
    titleUpdatedAt: 30,
  });
  const [stillCleared] = preserveNewerNamedThreadActivity(
    [tombstone],
    [namedThread({ titleEventId: "a", titleUpdatedAt: 20 })],
  );
  const [renamed] = preserveNewerNamedThreadActivity(
    [tombstone],
    [
      namedThread({
        title: "Named again",
        titleEventId: "a",
        titleUpdatedAt: 31,
      }),
    ],
  );

  assert.equal(stillCleared.title, "");
  assert.equal(renamed.title, "Named again");
});

test("equal-second title state uses event id and partial refetch preserves omitted roots", () => {
  const omitted = namedThread({
    channelId: "general",
    rootId: QUIET_ROOT,
    title: "Keep me",
  });
  const [winner, preserved] = preserveNewerNamedThreadActivity(
    [
      namedThread({
        title: "",
        titleEventId: "z",
        titleUpdatedAt: 30,
      }),
      omitted,
    ],
    [
      namedThread({
        title: "Older id",
        titleEventId: "a",
        titleUpdatedAt: 30,
      }),
    ],
  );

  assert.equal(winner.title, "");
  assert.equal(preserved, omitted);
});

test("loads history independently per channel so one limit cannot evict another channel", async () => {
  const titleFilters = [];
  const deps = {
    async fetchEvents(filter) {
      const channelId = filter["#h"][0];
      if (filter.kinds.includes(40009)) {
        titleFilters.push(filter);
        if (channelId === "noisy") {
          return Array.from({ length: 1_000 }, (_, index) =>
            titleEvent(
              channelId,
              index.toString(16).padStart(64, "0"),
              `Noisy ${index}`,
              index,
              `noisy-title-${index}`,
            ),
          );
        }
        return [titleEvent(channelId, QUIET_ROOT, "Quiet", 10, "quiet-title")];
      }
      if (filter.ids) {
        return filter.ids.map((id, index) =>
          event({
            channelId,
            content: "Root",
            createdAt: index,
            id,
            kind: 9,
          }),
        );
      }
      return [];
    },
    async readArchivedEvents() {
      return [];
    },
  };

  const snapshot = await loadNamedThreadsForChannels(
    ["noisy", "quiet"],
    "me",
    deps,
  );

  assert.equal(titleFilters.length, 2);
  assert.deepEqual(
    titleFilters.map((filter) => filter["#h"]),
    [["noisy"], ["quiet"]],
  );
  assert.equal(
    snapshot.threads.find((thread) => thread.channelId === "quiet")?.title,
    "Quiet",
  );
  assert.deepEqual(snapshot.authoritativeChannelIds, ["noisy", "quiet"]);
});

test("one failed channel does not suppress a healthy channel cold load", async () => {
  const deps = {
    async fetchEvents(filter) {
      const channelId = filter["#h"][0];
      if (channelId === "broken") throw new Error("broken relay lane");
      if (filter.kinds.includes(40009)) {
        return [titleEvent("healthy", QUIET_ROOT, "Healthy", 10, "title")];
      }
      if (filter.ids) {
        return [
          event({
            channelId: "healthy",
            content: "Root",
            createdAt: 5,
            id: QUIET_ROOT,
            kind: 9,
          }),
        ];
      }
      return [];
    },
    async readArchivedEvents() {
      return [];
    },
  };

  const snapshot = await loadNamedThreadsForChannels(
    ["broken", "healthy"],
    "me",
    deps,
  );
  assert.deepEqual(
    snapshot.threads.map((thread) => thread.title),
    ["Healthy"],
  );
  assert.deepEqual(snapshot.authoritativeChannelIds, ["healthy"]);
});

test("all failed channels reject so React Query can retain its cache", async () => {
  const deps = {
    async fetchEvents() {
      throw new Error("all relay lanes offline");
    },
    async readArchivedEvents() {
      return [];
    },
  };

  await assert.rejects(
    loadNamedThreadsForChannels(["one", "two"], "me", deps),
    /all relay lanes offline/,
  );
});

test("successful snapshot absence preserves live new-title and clear states", () => {
  const liveTitle = namedThread({
    title: "Live title",
    titleEventId: "live-title",
    titleUpdatedAt: 50,
  });
  const liveClear = namedThread({
    rootId: QUIET_ROOT,
    title: "",
    titleEventId: "live-clear",
    titleUpdatedAt: 51,
  });

  const merged = preserveNewerNamedThreadActivity(
    [liveTitle, liveClear],
    [],
    [],
  );

  assert.deepEqual(merged, [liveTitle, liveClear]);
});

test("explicit invalid-root evidence removes only the matching cached title state", () => {
  const previous = [
    namedThread({ channelId: "general", rootId: GENERAL_ROOT }),
    namedThread({ channelId: "broken", rootId: QUIET_ROOT }),
  ];

  const merged = preserveNewerNamedThreadActivity(
    previous,
    [],
    [
      {
        channelId: "general",
        rootId: GENERAL_ROOT,
        titleEventId: "title",
        titleUpdatedAt: 10,
      },
    ],
  );

  assert.deepEqual(
    merged.map((thread) => `${thread.channelId}:${thread.rootId}`),
    [`broken:${QUIET_ROOT}`],
  );
});

test("failed channel retains a previously cached root omitted from the snapshot", () => {
  const cached = namedThread({
    channelId: "broken",
    rootId: GENERAL_ROOT,
  });

  const merged = preserveNewerNamedThreadActivity([cached], [], []);

  assert.deepEqual(merged, [cached]);
});

test("successful relay root miss emits versioned removal evidence even with an archived root", async () => {
  const cached = namedThread();
  const deps = {
    async fetchEvents() {
      return [];
    },
    async readArchivedEvents(_channelId, kinds) {
      return kinds.includes(40009)
        ? []
        : [
            event({
              channelId: "general",
              content: "Archived root",
              createdAt: 5,
              id: GENERAL_ROOT,
              kind: 9,
            }),
          ];
    },
  };

  const snapshot = await loadNamedThreadsForChannels(["general"], "me", deps, [
    cached,
  ]);

  assert.deepEqual(snapshot.invalidRootStates, [
    {
      channelId: "general",
      rootId: GENERAL_ROOT,
      titleEventId: "title",
      titleUpdatedAt: 10,
    },
  ]);
  assert.deepEqual(
    preserveNewerNamedThreadActivity(
      [cached],
      snapshot.threads,
      snapshot.invalidRootStates,
    ),
    [],
  );
});

test("cold load does not resurrect a relay-missing root from stale archive evidence", async () => {
  const deps = {
    async fetchEvents(filter) {
      return filter.kinds.includes(40009)
        ? [titleEvent("general", GENERAL_ROOT, "Stale title", 10, "title")]
        : [];
    },
    async readArchivedEvents(_channelId, kinds) {
      return kinds.includes(40009)
        ? []
        : [
            event({
              channelId: "general",
              content: "Stale archived root",
              createdAt: 5,
              id: GENERAL_ROOT,
              kind: 9,
            }),
          ];
    },
  };

  const snapshot = await loadNamedThreadsForChannels(["general"], "me", deps);

  assert.deepEqual(snapshot.threads, []);
});

test("stale invalid-root evidence cannot remove a newer live clear", () => {
  const liveClear = namedThread({
    title: "",
    titleEventId: "live-clear",
    titleUpdatedAt: 50,
  });

  const merged = preserveNewerNamedThreadActivity(
    [liveClear],
    [],
    [
      {
        channelId: "general",
        rootId: GENERAL_ROOT,
        titleEventId: "old-title",
        titleUpdatedAt: 10,
      },
    ],
  );

  assert.deepEqual(merged, [liveClear]);
});

test("newer cleared history title suppresses an older archived title", async () => {
  const deps = {
    async fetchEvents(filter) {
      return filter.kinds.includes(40009)
        ? [titleEvent("general", GENERAL_ROOT, "", 20, "clear")]
        : [];
    },
    async readArchivedEvents(_channelId, kinds) {
      return kinds.includes(40009)
        ? [titleEvent("general", GENERAL_ROOT, "Archived", 10, "archived")]
        : [];
    },
  };

  const [tombstone] = await loadNamedThreadsForChannel("general", "me", deps);
  assert.equal(tombstone.title, "");
  assert.deepEqual(namedThreadsForChannel([tombstone], "general"), []);
});

test("relay failure plus an empty optional archive rejects instead of wiping cache", async () => {
  const deps = {
    async fetchEvents() {
      throw new Error("relay offline");
    },
    async readArchivedEvents() {
      return [];
    },
  };

  await assert.rejects(
    loadNamedThreadsForChannel("general", "me", deps),
    /relay offline/,
  );
});

test("archive alone restores a named thread and its unread activity on cold load", async () => {
  const deps = {
    async fetchEvents() {
      throw new Error("relay offline");
    },
    async readArchivedEvents(_channelId, kinds) {
      if (kinds.includes(40009)) {
        return [
          titleEvent("general", GENERAL_ROOT, "From archive", 10, "title"),
        ];
      }
      return [
        event({
          channelId: "general",
          content: "Archived root",
          createdAt: 5,
          id: GENERAL_ROOT,
          kind: 9,
        }),
        event({
          channelId: "general",
          content: "Archived reply",
          createdAt: 30,
          id: "reply",
          kind: 9,
          pubkey: "alice",
          rootId: GENERAL_ROOT,
        }),
      ];
    },
  };

  const [thread] = await loadNamedThreadsForChannel("general", "me", deps);
  assert.equal(thread.title, "From archive");
  assert.equal(thread.lastReplyAt, 30);
  assert.equal(thread.lastIncomingReplyAt, 30);
});

test("archived title accepts relay root evidence when relay title history fails", async () => {
  const deps = {
    async fetchEvents(filter) {
      if (filter.kinds.includes(40009)) {
        throw new Error("title history unavailable");
      }
      if (filter.ids) {
        return [
          event({
            channelId: "general",
            content: "Relay root",
            createdAt: 5,
            id: GENERAL_ROOT,
            kind: 9,
          }),
        ];
      }
      return [];
    },
    async readArchivedEvents(_channelId, kinds) {
      return kinds.includes(40009)
        ? [titleEvent("general", GENERAL_ROOT, "Archived title", 10, "title")]
        : [];
    },
  };

  const [thread] = await loadNamedThreadsForChannel("general", "me", deps);
  assert.equal(thread.title, "Archived title");
});

test("relay pagination retains every named thread before the twelve-row projection", async () => {
  const count = 2_505;
  const titles = Array.from({ length: count }, (_, index) =>
    titleEvent(
      "busy",
      index.toString(16).padStart(64, "0"),
      `Thread ${index}`,
      index + 1,
      `title-${index.toString().padStart(4, "0")}`,
    ),
  );
  const roots = new Map(
    titles.map((title) => [
      title.tags.find((tag) => tag[0] === "e")[1],
      event({
        channelId: "busy",
        content: "Root",
        createdAt: title.created_at,
        id: title.tags.find((tag) => tag[0] === "e")[1],
        kind: 9,
      }),
    ]),
  );
  const deps = {
    async fetchEvents(filter) {
      if (filter.kinds.includes(40009)) {
        return titles
          .filter(
            (title) =>
              (filter.since === undefined ||
                title.created_at >= filter.since) &&
              (filter.until === undefined || title.created_at <= filter.until),
          )
          .sort((left, right) => right.created_at - left.created_at)
          .slice(0, filter.limit)
          .sort((left, right) => left.created_at - right.created_at);
      }
      if (filter.ids) {
        return filter.ids.map((id) => roots.get(id)).filter(Boolean);
      }
      return [];
    },
    async readArchivedEvents() {
      return [];
    },
  };

  const threads = await loadNamedThreadsForChannel("busy", "me", deps);
  assert.equal(threads.length, count);
  assert.equal(namedThreadsForChannel(threads, "busy").length, 12);
});

test("archive pagination uses the compound cursor and retains same-second siblings", async () => {
  const firstPage = Array.from({ length: 1_000 }, (_, index) =>
    event({
      channelId: "general",
      createdAt: 10,
      id: (2_000 - index).toString(16).padStart(64, "0"),
      kind: 40009,
    }),
  );
  const finalEvent = event({
    channelId: "general",
    createdAt: 10,
    id: "0".repeat(64),
    kind: 40009,
  });
  const cursors = [];

  const events = await fetchAllNamedThreadArchivedEvents(
    "general",
    [40009],
    async (_channelId, _kinds, options) => {
      cursors.push(options.before);
      return options.before ? [finalEvent] : firstPage;
    },
  );

  assert.equal(events.length, 1_001);
  assert.deepEqual(cursors, [
    null,
    {
      createdAt: firstPage.at(-1).created_at,
      id: firstPage.at(-1).id,
    },
  ]);
});

test("relay pagination fails explicitly when one second cannot be paged losslessly", async () => {
  const denseSecond = Array.from({ length: 2_000 }, (_, index) =>
    event({
      channelId: "general",
      createdAt: 10,
      id: index.toString(16).padStart(64, "0"),
      kind: 40009,
    }),
  );

  await assert.rejects(
    fetchAllNamedThreadRelayEvents(
      { kinds: [40009], "#h": ["general"], limit: 2_000 },
      async () => denseSecond,
    ),
    /cannot be paged safely/,
  );
});
