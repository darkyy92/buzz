import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

const THREAD_ROOT_ID = "f".repeat(64);

async function expectThreadReadAtLeast(page: Page, timestamp: number) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ rootId }) => {
          let latest = 0;
          for (const [key, raw] of Object.entries(localStorage)) {
            if (!key.startsWith("buzz.channel-read-state.v2:")) continue;
            const value = JSON.parse(raw)[`thread:${rootId}`];
            if (typeof value === "string") {
              latest = Math.max(latest, Math.floor(Date.parse(value) / 1_000));
            }
          }
          return latest;
        },
        { rootId: THREAD_ROOT_ID },
      ),
    )
    .toBeGreaterThanOrEqual(timestamp);
}

test("thread rename persists to the relay-backed sidebar row", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await installMockBridge(page);
  await page.goto("/");

  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
      ),
    )
    .toBe(true);
  await page.evaluate(
    ({ pubkey, rootId }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Initial reply for named thread",
        parentEventId: rootId,
        pubkey,
        createdAt: Math.floor(Date.now() / 1_000) - 5,
      });
    },
    { pubkey: TEST_IDENTITIES.alice.pubkey, rootId: THREAD_ROOT_ID },
  );

  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${THREAD_ROOT_ID}"]`,
    )
    .click();
  const panel = page.getByTestId("message-thread-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("message-thread-title")).toContainText(
    "Named thread root for sidebar tests",
  );

  // Escape cancels title editing without closing the enclosing thread panel.
  await panel.getByTestId("rename-thread").click();
  const titleInput = panel.getByRole("textbox", { name: "Thread title" });
  await titleInput.fill("Cancelled title");
  await titleInput.press("Escape");
  await expect(titleInput).toHaveCount(0);
  await expect(panel).toBeVisible();

  await panel.getByTestId("rename-thread").click();
  await panel
    .getByRole("textbox", { name: "Thread title" })
    .fill("Release launch plan");
  await panel.getByRole("textbox", { name: "Thread title" }).press("Enter");

  await expect(panel.getByTestId("message-thread-title")).toHaveText(
    "Release launch plan",
  );
  const namedRow = page.getByTestId(`named-thread-${THREAD_ROOT_ID}`);
  await expect(namedRow).toBeVisible();
  await expect(namedRow).toHaveText("Release launch plan");
  await expect(namedRow).toHaveAttribute("data-active", "true");
  await expect(namedRow).toHaveAttribute("aria-current", "page");
  await expect(namedRow).toHaveAttribute("title", "Release launch plan");

  await waitForAnimations(page);
  await page.getByTestId("app-sidebar").screenshot({
    path: testInfo.outputPath("named-thread-sidebar.png"),
  });

  await page.getByTestId("auxiliary-panel-close").click();
  await page.getByTestId("channel-random").click();
  const unreadReplyAt = await page.evaluate(
    ({ pubkey, rootId }) => {
      const createdAt = Math.floor(Date.now() / 1_000) + 60;
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Unread reply after naming",
        parentEventId: rootId,
        pubkey,
        createdAt,
      });
      return createdAt;
    },
    { pubkey: TEST_IDENTITIES.alice.pubkey, rootId: THREAD_ROOT_ID },
  );
  const unreadDot = page.getByTestId(`named-thread-unread-${THREAD_ROOT_ID}`);
  await expect(unreadDot).toBeVisible();
  await expect(namedRow).toHaveAttribute(
    "aria-label",
    "Open thread Release launch plan, unread replies",
  );
  await namedRow.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("message-thread-title")).toHaveText(
    "Release launch plan",
  );
  await expect(page).toHaveURL(new RegExp(`thread=${THREAD_ROOT_ID}`));
  await expectThreadReadAtLeast(page, unreadReplyAt);

  // A later relay rename updates both surfaces. An active local draft remains
  // untouched until the user cancels or saves it.
  await panel.getByTestId("rename-thread").click();
  const remoteDraft = panel.getByRole("textbox", { name: "Thread title" });
  await remoteDraft.fill("Unsaved local draft");
  await page.evaluate(
    ({ pubkey, rootId }) => {
      window.__BUZZ_E2E_EMIT_MOCK_THREAD_TITLE__?.({
        channelName: "general",
        rootId,
        title: "Remote launch plan",
        pubkey,
        createdAt: Math.floor(Date.now() / 1_000) + 240,
      });
    },
    { pubkey: TEST_IDENTITIES.alice.pubkey, rootId: THREAD_ROOT_ID },
  );
  await expect(remoteDraft).toHaveValue("Unsaved local draft");
  await remoteDraft.press("Escape");
  await expect(panel.getByTestId("message-thread-title")).toHaveText(
    "Remote launch plan",
  );
  await expect(namedRow).toHaveText("Remote launch plan");

  // Opening from the named row advances the durable thread frontier.
  await page.getByTestId("auxiliary-panel-close").click();
  await expect(unreadDot).toHaveCount(0);
  await namedRow.click();
  await expect(panel).toBeVisible();
  await page.getByTestId("auxiliary-panel-close").click();
  await expect(panel).toHaveCount(0);
  await expect(unreadDot).toHaveCount(0);

  // A non-sidebar open is authoritative too: a thread-summary click must
  // advance the same durable frontier used by the named-thread unread dot.
  const summaryUnreadReplyAt = await page.evaluate(
    ({ pubkey, rootId }) => {
      const createdAt = Math.floor(Date.now() / 1_000) + 120;
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Unread reply before summary open",
        parentEventId: rootId,
        pubkey,
        createdAt,
      });
      return createdAt;
    },
    { pubkey: TEST_IDENTITIES.alice.pubkey, rootId: THREAD_ROOT_ID },
  );
  await expect(unreadDot).toBeVisible();
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${THREAD_ROOT_ID}"]`,
    )
    .click();
  await expect(panel).toBeVisible();
  await expectThreadReadAtLeast(page, summaryUnreadReplyAt);
  await page.getByTestId("auxiliary-panel-close").click();
  await expect(panel).toHaveCount(0);
  await page.evaluate(
    ({ pubkey, rootId }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Unread reply after the panel closed",
        parentEventId: rootId,
        pubkey,
        createdAt: Math.floor(Date.now() / 1_000) + 180,
      });
    },
    { pubkey: TEST_IDENTITIES.alice.pubkey, rootId: THREAD_ROOT_ID },
  );
  await expect(unreadDot).toBeVisible();

  // The exact root is URL-backed: a true cold reload reopens that thread even
  // when the in-memory named-title event cache has been rebuilt.
  await namedRow.click();
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`thread=${THREAD_ROOT_ID}`));
});
