import { expect, test, type Page } from "@playwright/test";
import { expandNeedsYou, needRow, needsPane, needsYouTray, openApp, openPipHome } from "./support/app";

// Fixes from the fifteenth dogfood round: a quiet run can be waited on without stopping it (G2) and a description update says
// it writes to Jira as the person (G8).

const peek = (page: Page) => page.locator("#peek-sheet");

test.describe("Keep waiting on a quiet run (G2)", () => {
  test("the quiet need leaves Needs you with Keep waiting, the run is not stopped, and Undo brings it back", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openPipHome(page);
    await expect(needsYouTray(page)).toBeVisible();
    await expandNeedsYou(page, "General");
    const quiet = needRow(page, /CA-377.*gone quiet/);
    await expect(quiet).toHaveCount(1);
    await quiet.click();
    await expect(needsPane(page).getByRole("button", { name: "Stop the run" })).toBeVisible();
    await needsPane(page).getByRole("button", { name: "Keep waiting" }).click();
    await expect(needRow(page, /CA-377.*gone quiet/)).toHaveCount(0);
    const toast = page.locator("[data-toast]").filter({ hasText: "it is out of Needs you for now" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(needRow(page, /CA-377.*gone quiet/)).toHaveCount(1);
  });
});

test.describe("The description update says who it writes as (G8)", () => {
  test("the card says it changes the ticket in Jira as you and that Jira notifies its watchers", async ({ page }) => {
    await openApp(page);
    await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
    const draft = peek(page).getByRole("article", { name: "Update the description of CA-401" });
    await expect(draft.locator("[data-rewrite-note]")).toHaveText("Changes the ticket's description in Jira as you; Jira notifies its watchers.");
  });
});

test.describe("Opening Agents (G9)", () => {
  test("puts the keyboard on the Agents heading, not in Pip's composer", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Agents/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeFocused();
  });
});
