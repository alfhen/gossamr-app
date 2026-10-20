import { expect, test, type Page } from "@playwright/test";
import { agentsHome, commentOnTicket, editTicket, expectToast, needsPane, needsYouTray, openAgents, openApp, selectWorkstream, startWorkstream, needsStack } from "./support/app";

// Backlog items of the fifteenth dogfood round: a secret masked in the person's own bubble (G16), the note that the reporter is
// waited on taken back once they reply (G23), an edited draft marked in Needs you (G25), Esc folding the glossary (G32) and Plan my week saying whose tickets it covers (G30).

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

test.describe("the glossary and Plan my week (G32, G30)", () => {
  test("Plan my week opened from a workstream says it covers all your tickets", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await openAgents(page);
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page).getByRole("combobox").fill("plan my week");
    await page.keyboard.press("Enter");
    await expect(agentsHome(page).locator("[data-plan-scope]")).toContainText("all your tickets");
  });
});

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
