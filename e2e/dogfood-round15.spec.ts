import { expect, test, type Page } from "@playwright/test";
import { expandNeedsYou, jiraWrites, needRow, needsPane, needsYouTray, openAgents, openApp, pipCommentDraft, selectWorkstream, startWorkstream } from "./support/app";

// Fixes from the fifteenth dogfood round: a quiet run can be waited on without stopping it (G2) and a description update says
// it writes to Jira as the person (G8).

const peek = (page: Page) => page.locator("#peek-sheet");

test.describe("A quiet run (G2)", () => {
  test("is not in Needs you, so there is nothing to keep waiting on", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await openAgents(page);
    await expect(needsYouTray(page)).toBeVisible();
    await expandNeedsYou(page, "General");
    await expect(needRow(page, /CA-377/)).toHaveCount(0);
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

test.describe("an edit kept when its card leaves (G1)", () => {
  test("an edit finished with Done editing is still on the card after the pane moves away and back, and posting posts it", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    await draft.getByRole("button", { name: "Edit" }).click();
    await needsPane(page).locator("textarea").first().fill("Kept after the card left.");
    await draft.getByRole("button", { name: "Done editing" }).click();
    // The card leaves: the pane is closed, then the draft is opened again from Needs you.
    await needsPane(page).getByRole("button", { name: "Hide" }).click();
    await expect(draft).toHaveCount(0);
    await needRow(page, /Draft comment/).click();
    await expect(draft).toContainText("Kept after the card left.");
    await draft.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.text)).toEqual([expect.stringContaining("Kept after the card left.")]);
  });
});
