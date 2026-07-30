import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

const THREAD_ROOT_ID = "mock-general-welcome";

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
    ({ pubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Initial reply for named thread",
        parentEventId: "mock-general-welcome",
        pubkey,
        createdAt: Math.floor(Date.now() / 1_000) - 5,
      });
    },
    { pubkey: TEST_IDENTITIES.alice.pubkey },
  );

  await page.getByTestId("message-thread-summary").first().click();
  const panel = page.getByTestId("message-thread-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("message-thread-title")).toContainText(
    "Welcome to #general",
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
  const namedRow = page.getByTestId("named-thread-mock-general-welcome");
  await expect(namedRow).toBeVisible();
  await expect(namedRow).toHaveText("Release launch plan");
  await expect(namedRow).toHaveAttribute("data-active", "true");
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
  const unreadDot = page.getByTestId(
    "named-thread-unread-mock-general-welcome",
  );
  await expect(unreadDot).toBeVisible();
  await namedRow.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("message-thread-title")).toHaveText(
    "Release launch plan",
  );
  await expect(page).toHaveURL(
    /#\/channels\/[^?]+\?(?:.*&)?thread=mock-general-welcome(?:&.*)?$/,
  );
  await expectThreadReadAtLeast(page, unreadReplyAt);

  // Opening from the named row advances the durable thread frontier.
  await page.getByTestId("auxiliary-panel-close").click();
  await expect(unreadDot).toHaveCount(0);
  await namedRow.click();
  await expect(panel).toBeVisible();
  await page.getByTestId("auxiliary-panel-close").click();
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
  await page.getByTestId("message-thread-summary").first().click();
  await expect(panel).toBeVisible();
  await expectThreadReadAtLeast(page, summaryUnreadReplyAt);
  await page.evaluate(
    ({ pubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Live reply after the panel opened",
        parentEventId: "mock-general-welcome",
        pubkey,
        createdAt: Math.floor(Date.now() / 1_000) + 180,
      });
    },
    { pubkey: TEST_IDENTITIES.alice.pubkey },
  );
  await page.getByTestId("auxiliary-panel-close").click();
  await expect(unreadDot).toBeVisible();
});
