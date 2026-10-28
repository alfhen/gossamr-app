import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, githubWrites, jiraWrites, showWorkspace, openApp, peekSheet, peekTicket, startAgent } from "./support/app";

/** The Agents view's cards; Pip's strip of agents shows runs too, and only the view counts. */
const cards = (page: Page) => page.locator('main article[data-run-id]:not(aside[aria-label="Pip"] *)');
const sheet = (page: Page) => page.locator("#agent-sheet");

/** The ids of the runs the Agents view shows. */
const runIds = async (page: Page) => (await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")))).filter((id): id is string => !!id);

test("a Review Pip starts for the finished build finishes as prose and leaves a review draft and a comment", async ({ page }) => {
  // A signed-in GitHub connection, so the code host knows the build's pull request #218 (`?mockRepos`, src/backend/mockWatch.ts).
  await page.goto("/?mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Work(,|$)/ }).click();
  await expect(cards(page).first()).toBeVisible();
  const before = await runIds(page);

  await startAgent(page, "CA-402", "reviewer", { repo: "acme/webshop", pr: 218 });

  await expect.poll(async () => (await runIds(page)).length).toBe(before.length + 1);
  const id = (await runIds(page)).find((r) => !before.includes(r))!;
  const card = cards(page).and(page.locator(`[data-run-id="${id}"]`));
  await expect(card).toContainText("Review");
  await expect(card.locator("[data-verdict]")).toHaveCount(0);

  // Queued, launching, working, done.
  await advanceRuns(page, 3, id);
  await expect(card).toHaveAttribute("data-state", "done");
  await expect(card.locator("[data-verdict]")).toHaveCount(0);

  await card.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator("[data-verdict]")).toHaveCount(0);
  await expect(sheet(page).getByRole("list", { name: "Findings" })).toHaveCount(0);
  await expect(sheet(page)).toContainText("the retry loop never backs off");

  // The finished review left exactly one GitHub review draft of #218, beside its Jira comment draft, and wrote nothing.
  expect(await jiraWrites(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-402");
  const review = peekSheet(page).getByRole("article", { name: "GitHub review of acme/webshop#218" });
  await expect(review).toHaveCount(1);
  await expect(peekSheet(page).getByRole("article", { name: "Comment on CA-402" })).toHaveCount(1);
  // The summary opens as a reviewer would write it, without the pull request's number or commit.
  await expect(review.locator("[data-review-summary]")).toHaveValue(/^Not ready to merge yet: 1 blocking issue, 1 should-fix and 1 nit\.\n\n/);
  // The finding without a line in the diff is in the summary; the other two sit at their lines.
  await expect(review.locator("[data-review-summary]")).toContainText("no test covers the timeout path. (src/consumer/retry.test.ts)");
  const comments = review.locator("[data-review-comment]");
  await expect(comments).toHaveCount(2);
  await expect(comments.nth(0)).toHaveAttribute("data-review-comment", "src/consumer/retry.ts:42");
  await expect(comments.nth(0)).toContainText("**Blocking:** the retry loop never backs off");
  await expect(comments.nth(1)).toHaveAttribute("data-review-comment", "src/consumer/retry.ts:17");
  // Nothing posts it until the person does: the card offers Approve and Skip, and GitHub hasn't been written to.
  await expect(review.getByRole("button", { name: "Skip" })).toBeVisible();
  await expect(review.getByRole("button", { name: "Approve" })).toBeVisible();
  expect(await githubWrites(page)).toEqual([]);
  expect(await jiraWrites(page)).toEqual([]);
});

test("a seeded review shows its report as prose", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /^Work(,|$)/ }).click();
  // CA-408's seeded review wrote a numbered list and no Verdict line.
  const review = cards(page).filter({ hasText: "Review" }).filter({ hasText: "CA-408" });
  await expect(review).toBeVisible();
  await expect(review.locator("[data-verdict]")).toHaveCount(0);
  await review.click();
  await expect(sheet(page).locator("[data-verdict]")).toHaveCount(0);
  await expect(sheet(page)).toContainText("The retry loop never backs off");
});
