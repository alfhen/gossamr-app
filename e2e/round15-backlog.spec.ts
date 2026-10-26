import { expect, test } from "@playwright/test";
import { needsPane, needsYouTray, openAgents, openApp, pipCommentDraft, selectWorkstream, startWorkstream, needsStack } from "./support/app";

// Backlog items of the fifteenth dogfood round: a secret masked in the person's own bubble (G16) and an edited draft marked
// in Needs you (G25).

test.describe("a draft the person edited (G25)", () => {
  test("is marked edited in Needs you once Done editing is pressed", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    await expect(draft).toBeVisible();
    await expect(needsYouTray(page).locator("[data-needs-you-edited]")).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nOne more thing to answer.`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(needsStack(page).locator("[data-needs-pane-edited]").first()).toBeVisible();
  });
});
