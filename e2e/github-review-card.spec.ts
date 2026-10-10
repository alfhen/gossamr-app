import { expect, test, type Locator, type Page } from "@playwright/test";
import { githubWrites, jiraWrites, movePullHead, openPip, pipPane, reviewedDraft } from "./support/app";

const RETRY = "src/consumer/retry.ts";
const pullView = (page: Page) => page.getByRole("dialog", { name: "Pull request acme/webshop#218" });

/** The review draft's preview card in the Pip pane, focused from the keyboard so it takes its keys. */
async function previewCard(page: Page): Promise<Locator> {
  await openPip(page);
  const card = pipPane(page).getByRole("article", { name: "GitHub review of acme/webshop#218" });
  await expect(card).toHaveCount(1);
  await card.focus();
  return card;
}

test("an edited comment and a dropped one change exactly what is posted, and the card shows Edited, then Posted", async ({ page }) => {
  const review = await reviewedDraft(page);
  // Each comment over the lines it is about, its own line marked.
  await expect(review.locator("[data-review-hunk]")).toHaveCount(2);
  await expect(review.locator(`[data-review-comment="${RETRY}:42"] [data-hunk-target]`)).toContainText("try { return await handle(message); }");
  await expect(review.locator(`[data-review-comment="${RETRY}:17"] [data-hunk-target]`)).toContainText("+const MAX = 5;");
  await expect(review.locator("[data-review-moved]")).toHaveCount(0);
  const jira = await jiraWrites(page);

  await review.getByRole("textbox", { name: `Comment on ${RETRY}:42` }).fill("Please back off between attempts; a tight loop hammers the queue.");
  await review.getByRole("button", { name: `Drop comment on ${RETRY}:17` }).click();
  await expect(review.locator(`[data-review-dropped="${RETRY}:17"]`)).toBeVisible();
  // Dropped, it can still come back until the edit is sent.
  await review.getByRole("button", { name: `Restore comment on ${RETRY}:17` }).click();
  await expect(review.getByRole("textbox", { name: `Comment on ${RETRY}:17` })).toBeVisible();
  await review.getByRole("button", { name: `Drop comment on ${RETRY}:17` }).click();
  expect(await githubWrites(page)).toEqual([]);

  await review.getByRole("button", { name: "Post review" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const [write] = await githubWrites(page);
  expect(write).toMatchObject({ repo: "acme/webshop", number: 218, event: "COMMENT", commitId: "a1b2c3d4e5f6" });
  expect(write.comments).toEqual([{ path: RETRY, line: 42, side: "RIGHT", body: "Please back off between attempts; a tight loop hammers the queue." }]);
  const card = page.locator(`[data-draft="${write.proposalId}"]`).first();
  await expect(card.locator("[data-review-edited]")).toHaveText("Edited");
  await expect(card.locator("[data-review-posted]")).toContainText("Posted to GitHub");
  await expect(card).toContainText("Posted");
  // The dropped comment is gone for good: nothing to restore.
  await expect(card.locator(`[data-review-dropped="${RETRY}:17"]`)).toHaveCount(0);
  expect(await githubWrites(page)).toHaveLength(1);
  expect(await jiraWrites(page)).toEqual(jira);
});

test("a token that can't post says why, offers the PR view with the review's comments inline instead, and a then Enter posts nothing", async ({ page }) => {
  const review = await reviewedDraft(page, "&mockReviewAccess=none");
  await expect(review.locator('[data-review-access="cant-post"]')).toHaveText("This GitHub token can't post reviews on acme/webshop (it lacks write access to its pull requests).");
  await expect(review.getByRole("button", { name: "Post review" })).toHaveCount(0);

  const open = review.getByRole("button", { name: "Open PR view" });
  await open.click();
  const view = pullView(page);
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { level: 2 })).toHaveText("CA-402: Cache the category tree (agent)");
  await expect(view.getByRole("navigation", { name: "Files" }).getByRole("listitem")).toHaveCount(2);
  await expect(view.locator('[data-pull-file="src/consumer/retry.ts"] [data-diff-line]').first()).toBeVisible();
  await expect(view.getByRole("note", { name: `Comment on ${RETRY}:42` })).toContainText("the retry loop never backs off");
  await expect(view.getByRole("note", { name: `Comment on ${RETRY}:17` })).toBeVisible();
  await expect(view.locator("[data-pull-summary]")).toContainText("no test covers the timeout path. (src/consumer/retry.test.ts)");
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(open).toBeFocused();

  // From its preview card, a can't post it: it only opens the draft, so Enter then confirms nothing.
  const card = await previewCard(page);
  await expect(card.getByRole("status")).toHaveText("s skip · ↵ open");
  await expect(card.getByRole("button", { name: "Open PR view →" })).toBeVisible();
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  // The mock GitHub refuses such a post before keeping it, so no write proves nothing: a post that was tried would have
  // come back refused, as an error on the draft and a toast. A moment on, there is neither, and the draft still waits.
  await page.waitForTimeout(500);
  await expect(page.getByText("Couldn't post that draft")).toHaveCount(0);
  await expect(page.getByText("can't write to pull requests")).toHaveCount(0);
  await expect(review.getByRole("alert")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-state", "pending");
  expect(await githubWrites(page)).toEqual([]);
});

test("after the pull request moves on the card warns before posting, and the post fails as Outdated with nothing written", async ({ page }) => {
  const review = await reviewedDraft(page);
  await expect(review.locator("[data-review-hunk]")).toHaveCount(2);
  expect(await movePullHead(page, "acme/webshop", 218)).toBe(true);
  await expect(review.locator("[data-review-moved]")).toHaveText(/^The pull request has moved on since this review: reviewed a1b2c3d4, now at moved\w*\. GitHub may mark these comments outdated\.$/);
  await review.getByRole("button", { name: "Post review" }).click();
  await expect(review.locator("[data-review-outdated]")).toHaveText("Outdated");
  await expect(review.getByRole("alert")).toContainText("no longer match the pull request; it is outdated");
  expect(await githubWrites(page)).toEqual([]);
});

test("the review's preview card warns that the pull request moved on before a posts it, as the full card does", async ({ page }) => {
  const review = await reviewedDraft(page);
  expect(await movePullHead(page, "acme/webshop", 218)).toBe(true);
  const card = await previewCard(page);
  await expect(card.locator("[data-preview-warning]")).toHaveText(/^The pull request has moved on since this review: reviewed a1b2c3d4, now at moved\w*\. GitHub may mark these comments outdated\.$/);
  await page.keyboard.press("a");
  await expect(card.getByRole("status")).toHaveText("↵ post this review · any other key cancels");
  await expect(card.locator("[data-preview-warning]")).toBeVisible();
  await page.keyboard.press("Enter");
  // The mock's push dropped the reviewed commit, so GitHub refuses it as outdated.
  await expect(review.locator("[data-review-outdated]")).toHaveText("Outdated");
  expect(await githubWrites(page)).toEqual([]);
});

test("a then Enter on the review's preview card posts it, once", async ({ page }) => {
  await reviewedDraft(page);
  const card = await previewCard(page);
  await expect(card.getByRole("status")).toHaveText("a post · s skip · ↵ open");
  await page.keyboard.press("a");
  await expect(card.getByRole("status")).toHaveText("↵ post this review · any other key cancels");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  expect((await githubWrites(page))[0].comments.map((c) => `${c.path}:${c.line}`)).toEqual([`${RETRY}:42`, `${RETRY}:17`]);
});
