import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

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
  await namedRow.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("message-thread-title")).toHaveText(
    "Release launch plan",
  );
  await expect(page).toHaveURL(
    /#\/channels\/[^?]+\?(?:.*&)?thread=mock-general-welcome(?:&.*)?$/,
  );
});
