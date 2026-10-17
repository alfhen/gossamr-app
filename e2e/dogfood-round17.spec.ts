import { expect, test } from "@playwright/test";
import { expandNeedsYou, needRow, needsPane, openApp, openPipHome } from "./support/app";

// Fixes from the seventeenth dogfood round: Keep waiting says what it does and is no x (G9); a toast with Undo keeps its text readable (G10).

test.describe("Keep waiting on a quiet run (G9, G10)", () => {
  test("says what it does under the buttons, and its toast keeps a readable column beside Undo", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openPipHome(page);
    await expandNeedsYou(page, "General");
    await needRow(page, /CA-377.*gone quiet/).click();
    const keep = needsPane(page).getByRole("button", { name: "Keep waiting" });
    await expect(needsPane(page).locator("[data-keep-waiting-help]")).toHaveText("Keep waiting leaves the run going and takes this out of Needs you until it goes quiet again.");
    await expect(keep).toHaveAccessibleDescription(/leaves the run going/);
    await keep.click();
    const toast = page.locator("[data-toast]").filter({ hasText: "it is out of Needs you for now" });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    expect((await toast.locator("[data-toast-text]").boundingBox())!.width).toBeGreaterThan(150);
  });
});

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
