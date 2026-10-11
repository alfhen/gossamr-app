import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, githubWrites, jiraWrites, openApp, peekSheet, peekTicket } from "./support/app";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
/** The Agents view's cards; Pip's strip of agents shows runs too, and only the view counts. */
const cards = (page: Page) => page.locator('main article[data-run-id]:not(aside[aria-label="Pip"] *)');
const sheet = (page: Page) => page.locator("#agent-sheet");

/** The ids of the runs the Agents view shows. */
const runIds = async (page: Page) => (await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")))).filter((id): id is string => !!id);

/** Presses Review this on the finished CA-402 build's card, past the safety sheet a fresh profile shows once at its first agent action. */
async function reviewTheBuild(page: Page) {
  const build = cards(page).filter({ hasText: "Build" }).filter({ hasText: "CA-402" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await build.getByRole("button", { name: "Review this" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
    await expect(safety(page)).toHaveCount(0);
  }
  await expect(setup(page)).toBeVisible();
}

test("a Review the person starts from Review this finishes with a blocking verdict shown on its card and sheet, read from its written answer", async ({ page }) => {
  // A signed-in GitHub connection, so the code host knows the build's pull request #218 (`?mockRepos`, src/backend/mockWatch.ts).
  await page.goto("/?mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Agents/ }).click();
  await expect(cards(page).first()).toBeVisible();
  const before = await runIds(page);

  await reviewTheBuild(page);
  // The adversarial instruction is what the person approves. A review always asks for the report, even with the setting
  // off: the box is ticked and locked, the prompt asks for the tool if it is there, and its written verdict is read.
  const report = setup(page).getByRole("checkbox", { name: "Let the agent report its result to Gossamr" });
  await expect(report).toBeChecked();
  await expect(report).toBeDisabled();
  await expect(setup(page).locator("[data-report-locked]")).toContainText("A review always reports its verdict. Reporting is off in Settings");
  const whole = setup(page).locator("details").filter({ hasText: "Show the whole prompt as one piece" });
  await whole.locator("summary").click();
  const prompt = whole.locator("pre");
  await expect(prompt).toContainText("Your job is to show that the change is not ready");
  await expect(prompt).toContainText("'Verdict: pass' (only when you tried and found nothing blocking) or 'Verdict: blocking'");
  await expect(prompt).toContainText("it never comments on, approves, requests changes on or otherwise changes the pull request");
  await expect(prompt).toContainText("Review pull request #218 in acme/webshop");
  await expect(prompt).toContainText("If the run-report tool `report_result` is available");
  await expect(prompt).toContainText("verdict ('pass' or 'blocking', required)");
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);

  await expect.poll(async () => (await runIds(page)).length).toBe(before.length + 1);
  const id = (await runIds(page)).find((r) => !before.includes(r))!;
  const card = cards(page).and(page.locator(`[data-run-id="${id}"]`));
  await expect(card).toContainText("Review");
  await expect(card.locator("[data-verdict]")).toHaveCount(0);

  // Queued, launching, working, done.
  await advanceRuns(page, 3, id);
  await expect(card).toHaveAttribute("data-state", "done");
  const chip = card.locator("[data-verdict]");
  await expect(chip).toHaveAttribute("data-verdict", "blocking");
  await expect(chip).toHaveAttribute("data-blocking-count", "1");
  await expect(chip).toHaveText("Blocking · 1");

  await card.click();
  await expect(sheet(page)).toBeVisible();
  const verdict = sheet(page).locator("p[data-verdict]");
  await expect(verdict).toHaveAttribute("data-verdict", "blocking");
  await expect(verdict).toHaveAttribute("data-blocking-count", "1");
  await expect(verdict).toContainText("Blocking: 1 blocking finding");
  await expect(verdict).toContainText("Read from its Verdict line");
  const findings = sheet(page).getByRole("list", { name: "Findings" }).locator("li");
  await expect(findings).toHaveCount(3);
  await expect(findings.nth(0)).toHaveAttribute("data-severity", "blocking");
  await expect(findings.nth(0)).toContainText("src/consumer/retry.ts:42");
  await expect(findings.nth(1)).toHaveAttribute("data-severity", "should-fix");
  await expect(findings.nth(2)).toHaveAttribute("data-severity", "nit");

  // The finished review left exactly one GitHub review draft of #218, beside its Jira comment draft, and wrote nothing.
  expect(await jiraWrites(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-402");
  const review = peekSheet(page).getByRole("article", { name: "GitHub review of acme/webshop#218" });
  await expect(review).toHaveCount(1);
  await expect(peekSheet(page).getByRole("article", { name: "Comment on CA-402" })).toHaveCount(1);
  await expect(review.locator("[data-review-summary]")).toContainText("Gossamr review of #218 at a1b2c3d4: blocking (1 blocking, 1 should-fix, 1 nit).");
  // The finding without a line in the diff is in the summary; the other two sit at their lines.
  await expect(review.locator("[data-review-summary]")).toContainText("no test covers the timeout path. (src/consumer/retry.test.ts)");
  const comments = review.locator("[data-review-comment]");
  await expect(comments).toHaveCount(2);
  await expect(comments.nth(0)).toHaveAttribute("data-review-comment", "src/consumer/retry.ts:42");
  await expect(comments.nth(0)).toContainText("**Blocking:** the retry loop never backs off");
  await expect(comments.nth(1)).toHaveAttribute("data-review-comment", "src/consumer/retry.ts:17");
  // Nothing posts it until the person does: the card offers Post review and Discard, and GitHub hasn't been written to.
  await expect(review.getByRole("button", { name: "Discard" })).toBeVisible();
  await expect(review.getByRole("button", { name: "Post review" })).toBeVisible();
  await expect(review.getByRole("button", { name: /^(Apply|Approve)/ })).toHaveCount(0);
  expect(await githubWrites(page)).toEqual([]);
  expect(await jiraWrites(page)).toEqual([]);
});

test("a review that finished before reviews gave a verdict says it gave none", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: /^Agents/ }).click();
  // CA-408's seeded review wrote a numbered list and no Verdict line.
  const review = cards(page).filter({ hasText: "Review" }).filter({ hasText: "CA-408" });
  await expect(review).toBeVisible();
  await expect(review.locator("[data-verdict]")).toHaveCount(0);
  await review.click();
  await expect(sheet(page).locator('[data-verdict="none"]')).toHaveText(/The reviewer gave no verdict/);
});
