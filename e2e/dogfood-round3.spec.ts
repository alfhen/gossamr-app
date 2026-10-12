import { expect, test, type Page } from "@playwright/test";
import { expandNeedsYou, homeConversationRegion, needRow, needsYouCount, openApp, openPipHome, peekSheet, reviewedDraft } from "./support/app";

// Fixes from the third dogfood round: counts that stay one number once Agents is opened, and the GitHub review card
// saying what it will post and in plain words.

const railButton = (page: Page, name: RegExp) => page.getByRole("button", { name }).first();

test.describe("a folder to trust keeps waiting on the person (R5)", () => {
  test("opening Agents leaves it in Needs you and in the one count, on the rail and in the Agents header alike", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    const count = await needsYouCount(page).innerText();
    await railButton(page, /^Agents/).click();
    const header = page.locator("main header").filter({ has: page.getByRole("heading", { name: "Agents" }) });
    await expect(header).toContainText(`${count} need you`);
    // Agents has no badge of its own; Pip home's is the one count.
    await expect(railButton(page, /^Agents/)).toHaveAccessibleName("Agents");
    await expect(railButton(page, /^Pip home/)).toHaveAccessibleName(`Pip home, ${count} things need you`);
    // Back on Pip home, the folder to trust is still a need, and the count has not moved.
    await openPipHome(page);
    await expect(needsYouCount(page)).toHaveText(count);
    await expandNeedsYou(page);
    await expect(needRow(page, /needs its folder trusted/)).toHaveCount(1);
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

  test("the text boxes keep their Markdown and a rendered preview shows what GitHub will, in the card and the pull request view", async ({ page }) => {
    const review = await reviewedDraft(page);
    const comment = review.getByRole("textbox", { name: /^Comment on / }).first();
    await expect(comment).toHaveValue(/\*\*/);
    const preview = review.locator("[data-review-preview]").first();
    await expect(preview).toBeVisible();
    expect(await preview.innerText()).not.toMatch(/\*\*/);
    await expect(preview.locator("b").first()).toBeVisible();
    await review.getByRole("button", { name: "Open PR view" }).click();
    const banner = page.locator("[data-pull-summary]");
    await expect(banner).toBeVisible();
    expect(await banner.innerText()).not.toMatch(/\*\*|`|^#/m);
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
