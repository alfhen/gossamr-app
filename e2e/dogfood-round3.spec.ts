import { expect, test, type Page } from "@playwright/test";
import { expandNeedsYou, needRow, needsYouCount, openAgents, openApp, reviewedDraft } from "./support/app";

// Fixes from the third dogfood round: counts that stay one number once Agents is opened, and the GitHub review card
// saying what it will post and in plain words.

const railButton = (page: Page, name: RegExp) => page.locator("[data-rail]").getByRole("button", { name }).first();

test.describe("a folder to trust keeps waiting on the person (R5)", () => {
  test("opening Agents leaves it in Needs you and in the one count, on the rail and in the Agents header alike", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const count = await needsYouCount(page).innerText();
    await railButton(page, /^Agents/).click();
    await expect(needsYouCount(page)).toHaveText(count);
    // The rail's Agents badge is the one count.
    await expect(railButton(page, /^Agents/)).toHaveAccessibleName(`Agents, ${count} things need you`);
    // Back on Pip home, the folder to trust is still a need, and the count has not moved.
    await openAgents(page);
    await expect(needsYouCount(page)).toHaveText(count);
    await expandNeedsYou(page);
    await expect(needRow(page, /needs its folder trusted/)).toHaveCount(1);
  });
});

test.describe("the GitHub review card says what it posts (R13, R4)", () => {
  test("the text boxes keep their Markdown and a rendered preview shows what GitHub will, in the card", async ({ page }) => {
    const review = await reviewedDraft(page);
    const comment = review.getByRole("textbox", { name: /^Comment on / }).first();
    await expect(comment).toHaveValue(/\*\*/);
    const preview = review.locator("[data-review-preview]").first();
    await expect(preview).toBeVisible();
    expect(await preview.innerText()).not.toMatch(/\*\*/);
    await expect(preview.locator("b").first()).toBeVisible();
  });

  test("once posted, the card says how many comments it went with", async ({ page }) => {
    const review = await reviewedDraft(page);
    await review.getByRole("button", { name: "Approve" }).click();
    await expect(review.locator("[data-review-posted-with]")).toHaveText(/^Posted with \d+ comments?$/);
  });
});
