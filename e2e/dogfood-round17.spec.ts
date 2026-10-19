import { expect, test } from "@playwright/test";
import { openApp, openPipHome } from "./support/app";

// Fixes from the seventeenth dogfood round: Ctrl+Z with nothing to undo says so (G8).

test.describe("Ctrl+Z with nothing to undo (G8)", () => {
  test("says so, and that what was posted stays posted", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openPipHome(page);
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Control+z");
    await expect(page.locator("[data-toast]").filter({ hasText: "Nothing to undo. What was posted to Jira stays posted." })).toBeVisible();
  });
});
