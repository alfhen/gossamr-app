import { expect, test } from "@playwright/test";
import { githubPostsTried, githubWrites, jiraWrites, loseNextReviewAnswer, movePullHead, peekSheet, reviewedDraft } from "./support/app";

test("approving a finished review's GitHub draft posts exactly one comment review with its inline comments, and nothing else", async ({ page }) => {
  const review = await reviewedDraft(page);
  await expect(peekSheet(page).getByRole("article", { name: "Comment on CA-402" })).toHaveCount(1);
  // Nothing is posted until the person approves it.
  expect(await githubWrites(page)).toEqual([]);
  const jira = await jiraWrites(page);

  await review.getByRole("button", { name: "Post review" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const [write] = await githubWrites(page);
  expect(write).toMatchObject({ repo: "acme/webshop", number: 218, event: "COMMENT", commitId: "a1b2c3d4e5f6" });
  expect(write.comments.map((c) => `${c.path}:${c.line}:${c.side}`)).toEqual(["src/consumer/retry.ts:42:RIGHT", "src/consumer/retry.ts:17:RIGHT"]);
  expect(write.comments[0].body).toContain("the retry loop never backs off");
  // The finding without a line in the diff went in the review's body.
  expect(write.body).toContain("no test covers the timeout path. (src/consumer/retry.test.ts)");
  const posted = page.locator(`[data-draft="${write.proposalId}"] [data-review-posted]`).first();
  await expect(posted).toContainText("Posted to GitHub");
  await expect(posted.getByRole("link")).toHaveAttribute("href", /^https:\/\/github\.com\/acme\/webshop\/pull\/218#pullrequestreview-\d+$/);
  expect(await githubWrites(page)).toHaveLength(1);
  expect(await jiraWrites(page)).toEqual(jira);
});

test("a token that can't write to pull requests says why on the card and offers no Post button", async ({ page }) => {
  const review = await reviewedDraft(page, "&mockReviewAccess=none");
  await expect(review.locator('[data-review-access="cant-post"]')).toHaveText("This GitHub token can't post reviews on acme/webshop (it lacks write access to its pull requests).");
  await expect(review.getByRole("button", { name: "Post review" })).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Discard" })).toBeVisible();
  // Nothing was tried: no refusal on the card. (The mock GitHub refuses such a post before keeping it, so the writes
  // alone can't tell.)
  await expect(review.getByRole("alert")).toHaveCount(0);
  expect(await githubWrites(page)).toEqual([]);
});

test("a review whose pull request moved on fails to post as outdated and posts nothing", async ({ page }) => {
  const review = await reviewedDraft(page);
  expect(await movePullHead(page, "acme/webshop", 218)).toBe(true);
  await review.getByRole("button", { name: "Post review" }).click();
  await expect(review.locator("[data-review-outdated]")).toHaveText("Outdated");
  await expect(review.getByRole("alert")).toContainText("no longer match the pull request; it is outdated");
  expect(await githubWrites(page)).toEqual([]);
});

test("a post whose answer was lost says the review may be on GitHub, sends nothing until Post anyway, then sends it once", async ({ page }) => {
  const review = await reviewedDraft(page);
  await loseNextReviewAnswer(page, false);
  await review.getByRole("button", { name: "Post review" }).click();
  await expect(review.locator("[data-review-maybe-posted]")).toContainText("This review may already be on GitHub");
  await expect(review.getByRole("alert")).toContainText("GitHub may have posted this review already");
  await expect(review.getByRole("button", { name: "Post anyway" })).toHaveCount(0);

  // Posting again looks for it on GitHub, doesn't find it, and still sends nothing.
  await review.getByRole("button", { name: "Post review" }).click();
  await expect(review.getByRole("alert")).toContainText("didn't find the review it may have posted");
  expect(await githubPostsTried(page)).toBe(1);
  expect(await githubWrites(page)).toEqual([]);

  await review.getByRole("button", { name: "Post anyway" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const [write] = await githubWrites(page);
  await expect(page.locator(`[data-draft="${write.proposalId}"] [data-review-posted]`).first()).toContainText("Posted to GitHub");
  expect(await githubPostsTried(page)).toBe(2);
});

test("a review that went through though its answer was lost is found by what was sent, even after an edit, and not sent again", async ({ page }) => {
  const review = await reviewedDraft(page);
  await loseNextReviewAnswer(page, true);
  await review.getByRole("button", { name: "Post review" }).click();
  await expect(review.locator("[data-review-maybe-posted]")).toBeVisible();
  const [sent] = await githubWrites(page);

  await review.getByRole("textbox", { name: "Review summary" }).fill("My own words.");
  await review.getByRole("button", { name: "Post review" }).click();
  await expect(page.locator(`[data-draft="${sent.proposalId}"] [data-review-posted]`).first()).toContainText("Posted to GitHub");
  expect((await githubWrites(page)).map((w) => w.body)).toEqual([sent.body]);
  expect(await githubPostsTried(page)).toBe(1);
});
