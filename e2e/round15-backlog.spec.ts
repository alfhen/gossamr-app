import { expect, test, type Page } from "@playwright/test";
import { commentOnTicket, editTicket, expectToast, homeComposer, needsPane, needsYouTray, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Backlog items of the fifteenth dogfood round: a secret masked in the person's own bubble (G16), the note that the reporter is
// waited on taken back once they reply (G23), an edited draft marked in Needs you (G25), Esc folding the glossary (G32) and Plan my week saying whose tickets it covers (G30).

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

test.describe("a pasted secret in the person's own bubble (G16)", () => {
  test("shows masked once sent, with the rest of the message kept", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await homeComposer(page).fill("Is this ok to share? Password: hunter22secret");
    await homeComposer(page).press("Enter");
    const bubble = pipHome(page).locator("[data-user-bubble]").last();
    await expect(bubble).toContainText("Is this ok to share? Password: hu…");
    await expect(bubble).not.toContainText("hunter22secret");
  });
});

test.describe("the glossary and Plan my week (G32, G30)", () => {
  test("Esc folds the words away and keeps the keyboard on their button", async ({ page }) => {
    await openApp(page, "runs=empty");
    await page.evaluate(() => localStorage.removeItem("gossamr-prefs"));
    await page.reload();
    await openPipHome(page);
    const card = pipHome(page).locator("[data-pip-orientation]");
    const words = card.getByRole("button", { name: "What the words mean" });
    await words.click();
    await expect(card.getByRole("term").first()).toBeVisible();
    await expect(card.getByRole("term").filter({ hasText: /^Triage$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.getByRole("term")).toHaveCount(0);
    await expect(words).toBeFocused();
    await expect(words).toHaveAttribute("aria-expanded", "false");
  });

  test("Plan my week opened from a workstream says it covers all your tickets", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page).getByRole("combobox").fill("plan my week");
    await page.keyboard.press("Enter");
    await expect(pipHome(page).locator("[data-plan-scope]")).toContainText("all your tickets");
  });
});

test.describe("a draft the person edited (G25)", () => {
  test("is marked edited in Needs you once Done editing is pressed", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await editTicket(page, "CA-408", { description: "Fix it." });
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(draft).toBeVisible();
    await expect(needsYouTray(page).locator("[data-needs-you-edited]")).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\nOne more thing to answer.`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(needsYouTray(page).locator("[data-needs-you-edited]").first()).toBeVisible();
  });
});

test.describe("the note that the reporter is waited on (G23)", () => {
  test("is taken off the screen when the reporter replies, without waiting out its timer", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await editTicket(page, "CA-408", { description: "Fix it." });
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    await needsPane(page).getByRole("article", { name: "Comment on CA-408" }).getByRole("button", { name: "Post comment" }).click();
    const note = page.locator("[data-toast]").filter({ hasText: "now waits on the reporter" });
    await expectToast(page, "now waits on the reporter");
    await commentOnTicket(page, "CA-408", "Done means all three emails send in the sandbox.");
    await expect(note).toHaveCount(0, { timeout: 2_500 });
  });
});
