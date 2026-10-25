import { expect, test } from "@playwright/test";
import { agentsHome, commentOnTicket, editTicket, expectToast, needsPane, needsYouTray, openAgents, openApp, selectWorkstream, startWorkstream, needsStack } from "./support/app";

// Backlog items of the fifteenth dogfood round: a secret masked in the person's own bubble (G16), the note that the reporter is
// waited on taken back once they reply (G23) and an edited draft marked in Needs you (G25).

test.describe("a draft the person edited (G25)", () => {
  test("is marked edited in Needs you once Done editing is pressed", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await editTicket(page, "CA-408", { description: "Fix it." });
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(draft).toBeVisible();
    await expect(needsYouTray(page).locator("[data-needs-you-edited]")).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nOne more thing to answer.`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(needsStack(page).locator("[data-needs-pane-edited]").first()).toBeVisible();
  });
});

test.describe("the note that the reporter is waited on (G23)", () => {
  test("is taken off the screen when the reporter replies, without waiting out its timer", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await editTicket(page, "CA-408", { description: "Fix it." });
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
    const note = page.locator("[data-toast]").filter({ hasText: "now waits on the reporter" });
    await expectToast(page, "now waits on the reporter");
    await commentOnTicket(page, "CA-408", "Done means all three emails send in the sandbox.");
    await expect(note).toHaveCount(0, { timeout: 2_500 });
  });
});
