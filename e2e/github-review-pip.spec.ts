import { expect, test, type Locator, type Page } from "@playwright/test";
import { askPip, githubWrites, pipIdle, pipPane, reviewedDraft } from "./support/app";

const AT_42 = "src/consumer/retry.ts:42";
const AT_17 = "src/consumer/retry.ts:17";

/** Waits until the sample Pip has nothing running or waiting. */
const settled = (page: Page) => expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);

/** Presses the card's Discuss with Pip and waits for Pip to have read the draft. */
async function discuss(page: Page, review: Locator) {
  await review.getByRole("button", { name: "Discuss with Pip" }).click();
  await expect(pipPane(page)).toBeVisible();
  await expect(pipPane(page)).toContainText("in full, with the diff around each comment");
  await settled(page);
}

/** Asks Pip `what` in its pane and waits for the answer. */
async function ask(page: Page, what: string) {
  await askPip(page, what);
  await expect(pipPane(page).getByText(what, { exact: true }).last()).toBeVisible();
  await settled(page);
}

test("Pip softens and drops review comments only in the draft, and posting sends exactly one review with Pip's wording", async ({ page }) => {
  const review = await reviewedDraft(page);
  await discuss(page, review);
  expect(await githubWrites(page)).toEqual([]);

  await ask(page, `soften the comment on ${AT_42}`);
  await expect(pipPane(page)).toContainText(`I softened the comment on ${AT_42} into a suggestion.`);
  await expect(pipPane(page)).toContainText("nothing was posted to GitHub");
  await expect(review.getByRole("textbox", { name: `Comment on ${AT_42}` })).toHaveValue(/^Suggestion, if you agree: the retry loop never backs off/);
  await expect(review.locator("[data-review-revision]")).toHaveText("Revised by Pip");
  expect(await githubWrites(page)).toEqual([]);

  await ask(page, "drop the nit");
  await expect(pipPane(page)).toContainText(`I dropped the comment on ${AT_17}.`);
  await expect(review.locator(`[data-review-comment="${AT_17}"]`)).toHaveCount(0);
  await expect(review.locator(`[data-review-comment="${AT_42}"]`)).toHaveCount(1);
  expect(await githubWrites(page)).toEqual([]);

  await review.getByRole("button", { name: "Post review" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const [write] = await githubWrites(page);
  expect(write).toMatchObject({ repo: "acme/webshop", number: 218, event: "COMMENT", commitId: "a1b2c3d4e5f6" });
  expect(write.comments.map((c) => `${c.path}:${c.line}`)).toEqual([AT_42]);
  expect(write.comments[0].body).toMatch(/^Suggestion, if you agree: the retry loop never backs off/);
  await expect(review.locator("[data-review-posted]")).toContainText("Posted to GitHub");
  expect(await githubWrites(page)).toHaveLength(1);
});

test("a review draft the person edited stays theirs: Pip says so and changes nothing", async ({ page }) => {
  const review = await reviewedDraft(page);
  const comment = review.getByRole("textbox", { name: `Comment on ${AT_42}` });
  await comment.fill("My own words about the retry loop.");
  // Discussing saves the person's edit first, so Pip reads their version.
  await discuss(page, review);
  await expect(review.locator("[data-review-edited]")).toHaveText("Edited");

  await ask(page, `soften the comment on ${AT_42}`);
  await expect(pipPane(page)).toContainText("the user edited this review draft, so Pip can't change it any more");
  await expect(pipPane(page)).toContainText("it's yours and stays as you left it");
  await expect(comment).toHaveValue("My own words about the retry loop.");
  await expect(review.locator("[data-review-revision]")).toHaveCount(0);
  expect(await githubWrites(page)).toEqual([]);
});

test("Pip revising a draft the person is editing keeps their unsaved words on the comments it still has, and posting sends that", async ({ page }) => {
  const review = await reviewedDraft(page);
  await discuss(page, review);
  await review.getByRole("textbox", { name: `Comment on ${AT_17}` }).fill("My own words about MAX.");
  await ask(page, `drop the comment on ${AT_42}`);
  await expect(pipPane(page)).toContainText(`I dropped the comment on ${AT_42}`);

  // The card follows Pip: the dropped comment is gone, the person's words stay, and nothing blocks posting.
  await expect(review.locator(`[data-review-comment="${AT_42}"]`)).toHaveCount(0);
  await expect(review.getByRole("textbox", { name: `Comment on ${AT_17}` })).toHaveValue("My own words about MAX.");
  await expect(review.locator("[data-review-followed]")).toContainText("This draft changed while you were editing it.");
  await expect(review.getByRole("alert")).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Discuss with Pip" })).toBeEnabled();
  expect(await githubWrites(page)).toEqual([]);

  await review.getByRole("button", { name: "Post review" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const [write] = await githubWrites(page);
  expect(write.comments.map((c) => [`${c.path}:${c.line}`, c.body])).toEqual([[AT_17, "My own words about MAX."]]);
});
