import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { finalizeEvent } from "nostr-tools/pure";

import type { RelayEvent } from "../../src/shared/api/types";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const THREAD_ROOT_ID = "mock-general-welcome";
const D_TAG = "buzz:agent-commands:v1";
const T_TAG = "buzz-agent-commands";
const CREATED_AT = 1_800_000_000;

function catalogEvent(
  identity: (typeof TEST_IDENTITIES)[keyof typeof TEST_IDENTITIES],
  commands: Array<{ name: string; description: string }>,
  createdAt = CREATED_AT,
): RelayEvent {
  const event = finalizeEvent(
    {
      kind: 30078,
      created_at: createdAt,
      tags: [["d", D_TAG], ["t", T_TAG], ["-"]],
      content: JSON.stringify({ version: 1, commands }),
    },
    hexToBytes(identity.privateKey),
  );
  return { ...event, tags: event.tags.map((tag) => [...tag]) };
}

const INITIAL_CATALOGS = [
  catalogEvent(TEST_IDENTITIES.alice, [
    { name: "review", description: "Review the current changes" },
    { name: "goal", description: "Set or inspect the active goal" },
  ]),
  catalogEvent(TEST_IDENTITIES.charlie, [
    { name: "inspect", description: "Inspect the current workspace" },
  ]),
];

function channelComposer(page: Page): Locator {
  return page.getByTestId("channel-composer-overlay");
}

async function latestSentMessage(page: Page) {
  return page.evaluate(() => {
    const entry = (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).findLast(
      (candidate) => candidate.command === "send_channel_message",
    );
    return entry?.payload as
      | {
          channelId?: string;
          content?: string;
          parentEventId?: string | null;
        }
      | undefined;
  });
}

async function openGeneral(page: Page) {
  await page.goto(`/#/channels/${CHANNEL_ID}`, {
    waitUntil: "domcontentloaded",
  });
  // The first cold desktop bundle load can exceed Playwright's 5s assertion
  // default on CI and development Macs.
  await expect(page.getByTestId("chat-title")).toHaveText("general", {
    timeout: 15_000,
  });
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page, {
    agentCommandCatalogEvents: INITIAL_CATALOGS,
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        status: "running",
        channelIds: [CHANNEL_ID],
      },
      {
        pubkey: TEST_IDENTITIES.charlie.pubkey,
        name: "charlie",
        status: "running",
        channelIds: [CHANNEL_ID],
      },
    ],
  });
  await openGeneral(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: "general",
            kind: 30078,
          }) ?? false,
      ),
    )
    .toBe(true);
  await page.evaluate((events) => {
    for (const event of events) {
      window.__BUZZ_E2E_PUBLISH_AGENT_COMMAND_CATALOG__?.(event);
    }
  }, INITIAL_CATALOGS);
});

test("keyboard selection is grouped, accessible, live, and focus-safe", async ({
  page,
}) => {
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("/");

  const palette = composer.getByRole("listbox", {
    name: "Agent slash commands",
  });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option")).toHaveCount(3);
  await expect(palette).toContainText("Review the current changes");
  await expect(palette).toContainText("Inspect the current workspace");
  const listboxId = await palette.getAttribute("id");
  expect(listboxId).toBeTruthy();
  await expect(input).toHaveAttribute("aria-controls", listboxId ?? "");
  await expect(input).toHaveAttribute("aria-expanded", "true");

  await input.press("ArrowUp");
  await expect(palette.getByRole("option").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("ArrowDown");
  await expect(palette.getByRole("option").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("Enter");
  await expect(input).toHaveText(/@alice \/review $/i);
  await expect(input).toBeFocused();

  await input.fill("/");
  const refreshed = catalogEvent(
    TEST_IDENTITIES.alice,
    [{ name: "plan", description: "Plan the next move" }],
    CREATED_AT + 1,
  );
  await page.evaluate((event) => {
    window.__BUZZ_E2E_PUBLISH_AGENT_COMMAND_CATALOG__?.(event);
  }, refreshed);
  await expect(palette.getByText("/plan", { exact: true })).toBeVisible();
  await expect(palette.getByText("/review", { exact: true })).toHaveCount(0);

  const completeCatalog = catalogEvent(
    TEST_IDENTITIES.alice,
    Array.from({ length: 464 }, (_, index) => ({
      name: `command-${index}`,
      description: `Native command ${index}`,
    })),
    CREATED_AT + 2,
  );
  const clearCharlie = catalogEvent(
    TEST_IDENTITIES.charlie,
    [],
    CREATED_AT + 1,
  );
  await page.evaluate(
    ([catalog, clear]) => {
      window.__BUZZ_E2E_PUBLISH_AGENT_COMMAND_CATALOG__?.(catalog);
      window.__BUZZ_E2E_PUBLISH_AGENT_COMMAND_CATALOG__?.(clear);
    },
    [completeCatalog, clearCharlie],
  );
  await expect(palette.getByRole("option")).toHaveCount(12);
  await expect(composer.getByTestId("slash-command-footer")).toHaveText(
    "Type to search all 464 commands",
  );
  await composer.getByTestId("slash-command-autocomplete").screenshot({
    path: "test-results/slash-command-autocomplete/palette.png",
  });
  await input.fill("/command-463");
  await expect(
    palette.getByText("/command-463", { exact: true }),
  ).toBeVisible();
});

test("mouse, Escape, and ordinary prose keep composer semantics", async ({
  page,
}) => {
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");

  await input.fill("https://example.com/path");
  await expect(composer.getByTestId("slash-command-autocomplete")).toHaveCount(
    0,
  );
  await input.fill("/");
  await input.press("Escape");
  await expect(input).toHaveText("/");
  await expect(composer.getByTestId("slash-command-autocomplete")).toHaveCount(
    0,
  );

  // Reopen the palette through the same distinct edits a user makes so the
  // Escape dismissal is cleared before the slash query is entered again.
  await input.press("Backspace");
  await expect(input).toHaveText("");
  await input.type("/");
  await composer.getByText("/goal", { exact: true }).click();
  await expect(input).toHaveText(/@alice \/goal $/i);
  await expect(input).toBeFocused();
});

test("unknown slash commands still send from the channel composer", async ({
  page,
}) => {
  const composer = channelComposer(page);
  const input = composer.getByTestId("message-input");
  await input.fill("/unknown");

  const palette = composer.getByRole("listbox", {
    name: "Agent slash commands",
  });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option")).toHaveCount(0);
  await expect(composer).toContainText("No matching commands");

  await input.press("Enter");

  await expect(input).toHaveText("");
  await expect(page.getByText("/unknown", { exact: true })).toBeVisible();
});

test("unknown slash commands still send from the thread composer", async ({
  page,
}) => {
  await page.goto(
    `/#/channels/${CHANNEL_ID}?messageId=${THREAD_ROOT_ID}&thread=${THREAD_ROOT_ID}`,
    { waitUntil: "domcontentloaded" },
  );
  const thread = page.getByTestId("thread-composer-overlay");
  await expect(thread).toBeVisible();
  const input = thread.getByTestId("message-input");
  await input.fill("/unknown");

  const palette = thread.getByRole("listbox", {
    name: "Agent slash commands",
  });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option")).toHaveCount(0);
  await expect(thread).toContainText("No matching commands");

  await input.press("Enter");

  await expect
    .poll(() => latestSentMessage(page))
    .toMatchObject({
      channelId: CHANNEL_ID,
      content: "/unknown",
      parentEventId: THREAD_ROOT_ID,
    });
  await expect(input).toHaveText("");
});

test("explicit mentions scope commands in the thread composer", async ({
  page,
}) => {
  await page.goto(
    `/#/channels/${CHANNEL_ID}?messageId=${THREAD_ROOT_ID}&thread=${THREAD_ROOT_ID}`,
    { waitUntil: "domcontentloaded" },
  );
  const channel = channelComposer(page);
  const channelInput = channel.getByTestId("message-input");
  await channelInput.fill("/");
  const channelPalette = channel.getByRole("listbox", {
    name: "Agent slash commands",
  });
  const channelListboxId = await channelPalette.getAttribute("id");

  const thread = page.getByTestId("thread-composer-overlay");
  await expect(thread).toBeVisible();
  const input = thread.getByTestId("message-input");
  await input.fill("@charlie /");
  const palette = thread.getByRole("listbox", {
    name: "Agent slash commands",
  });
  const threadListboxId = await palette.getAttribute("id");
  expect(channelListboxId).toBeTruthy();
  expect(threadListboxId).toBeTruthy();
  expect(threadListboxId).not.toBe(channelListboxId);
  await expect(channelInput).toHaveAttribute(
    "aria-controls",
    channelListboxId ?? "",
  );
  await expect(input).toHaveAttribute("aria-controls", threadListboxId ?? "");
  const channelActiveOptionId = await channelInput.getAttribute(
    "aria-activedescendant",
  );
  const threadActiveOptionId = await input.getAttribute(
    "aria-activedescendant",
  );
  expect(channelActiveOptionId).toMatch(
    new RegExp(`^${channelListboxId}-option-\\d+$`),
  );
  expect(threadActiveOptionId).toMatch(
    new RegExp(`^${threadListboxId}-option-\\d+$`),
  );
  expect(threadActiveOptionId).not.toBe(channelActiveOptionId);
  await expect(palette.getByRole("option")).toHaveCount(1);
  await expect(palette.getByText("/inspect", { exact: true })).toBeVisible();
  await input.press("Shift+Tab");
  await expect(input).toHaveText("@charlie /");
  await input.focus();
  await input.press("Tab");
  await expect(input).toHaveText("@charlie /inspect ");
  await expect(input).toBeFocused();
});
