import { expect, test, type Page } from "@playwright/test";
import { homeConversationRegion, needsYouTray, openApp, openPipHome, peekSheet, reviewedDraft } from "./support/app";

// Fixes from the third dogfood round: counts that stay one number once Agents is opened, and the GitHub review card
// saying what it will post and in plain words.

const railButton = (page: Page, name: RegExp) => page.getByRole("button", { name }).first();

test.describe("a folder to trust keeps waiting on the person (R5)", () => {
  test("opening Agents leaves it in the Agents badge, its header and Needs you alike", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    const tray = needsYouTray(page);
    await expect(tray.locator("[data-needs-you-item]").first()).toBeVisible();
    const agentRows = await tray.locator('[data-needs-you-item][data-kind="question"], [data-needs-you-item][data-kind="permission"], [data-needs-you-item][data-kind="failure"]').count();
    await railButton(page, /^Agents/).click();
    const header = page.locator("main header").filter({ has: page.getByRole("heading", { name: "Agents" }) });
    await expect(header).toContainText(`${agentRows} waiting on you`);
    await expect(railButton(page, /^Agents/)).toHaveAccessibleName(`Agents, ${agentRows} agent ${agentRows === 1 ? "run waits" : "runs wait"} on you`);
    // Back on Pip home, the folder to trust is still a row in Needs you.
    await openPipHome(page);
    await expect(needsYouTray(page).getByRole("button", { name: /needs its folder trusted/ })).toHaveCount(1);
  });
});

test.describe("the GitHub review card says what it posts (R13, R4)", () => {
  test("its button names the comments, they are plain text in Pip's preview, and the posted card says how many went", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review.getByRole("button", { name: /^Post review \(2 comments\)$/ })).toBeVisible();
    await review.getByRole("button", { name: /^Drop comment on / }).first().click();
    await expect(review.getByRole("button", { name: /^Post review \(1 comment\)$/ })).toBeVisible();
    await peekSheet(page).getByRole("button", { name: "Close details" }).click();
    await openPipHome(page);
    const preview = homeConversationRegion(page).getByRole("article", { name: /GitHub review/ }).first();
    await expect(preview).toBeVisible();
    expect(await preview.innerText()).not.toMatch(/\*\*/);
  });

  test("once posted, the card says how many comments it went with", async ({ page }) => {
    const review = await reviewedDraft(page);
    await review.getByRole("button", { name: /^Post review/ }).click();
    await expect(review.locator("[data-review-posted-with]")).toHaveText(/^Posted with \d+ comments?$/);
  });
});

test.describe("keyboard, copy and focus fixes (R6, R10, R12, R14)", () => {
  test("Pip home's footer says a and s need Enter, and no longer lists a twice", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    const hints = page.locator("[data-pip-home-hints]");
    await expect(hints).toContainText("then ↵: approve or skip a draft");
    await expect(hints).not.toContainText("a opens a run draft");
  });
});
