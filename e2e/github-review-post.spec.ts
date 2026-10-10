import { expect, test } from "@playwright/test";
import { githubWrites, jiraWrites, movePullHead, peekSheet, reviewedDraft } from "./support/app";

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
