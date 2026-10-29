import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  advanceRuns, allProjects, askPip, githubPostsTried, githubWrites, jiraWrites, mockRuns, movePullHead, needRow,
  openAgents, openApp, openNeedRow, openPip, peekSheet, peekTicket, pendingReviewDrafts, pipIdle, pipPane,
  reviewDrafts, reviewedDraft, showWorkspace, startAgent,
} from "./support/app";

const RETRY = "src/consumer/retry.ts";

/** The review draft's preview card in the Pip pane, focused from the keyboard so it takes its keys. */
async function previewCard(page: Page): Promise<Locator> {
  await openPip(page);
  const card = pipPane(page).getByRole("article", { name: "GitHub review of acme/webshop#218" });
  await expect(card).toHaveCount(1);
  await card.focus();
  return card;
}

const AT_42 = "src/consumer/retry.ts:42";

const AT_17 = "src/consumer/retry.ts:17";

/** Waits until the sample Pip has nothing running or waiting. */
const settled = (page: Page) => expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);

/** Presses the card's Discuss with Pip and waits for Pip to have read the draft. */
async function discuss(page: Page, review: Locator) {
  await review.getByRole("button", { name: "Discuss with Pip" }).click();
  await expect(pipPane(page)).toBeVisible();
  await expect(pipPane(page)).toContainText("I read the review of acme/webshop#218 in full, with the diff around each comment");
  await expect(pipPane(page).locator('[data-turn-kind="user"]').last()).toContainText("Ask Pip about this draft");
  await settled(page);
}

/** Asks Pip `what` in its pane and waits for the answer. */
async function ask(page: Page, what: string) {
  await askPip(page, what);
  await expect(pipPane(page).getByText(what, { exact: true }).last()).toBeVisible();
  await settled(page);
}

/** Another Review of CA-402's build is started, as Pip does, and moved to done; its draft then waits in CA-402's peek. */
async function reviewAgain(page: Page) {
  await page.keyboard.press("Escape");
  const id = await startAgent(page, "CA-402", "reviewer", { repo: "acme/webshop", pr: 218 });
  await advanceRuns(page, 3, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
  await peekTicket(page, "CA-402");
  return id;
}

/** The Agents view's cards; Pip's strip of agents shows runs too, and only the view counts. */
const cards = (page: Page) => page.locator('main article[data-run-id]:not(aside[aria-label="Pip"] *)');

const sheet = (page: Page) => page.locator("#agent-sheet");

/** The ids of the runs the Agents view shows. */
const runIds = async (page: Page) => (await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")))).filter((id): id is string => !!id);

test.describe("the review card before posting", () => {
  test("posting sends the edit in the comment box", async ({ page }) => {
    const review = await reviewedDraft(page);
    const box = review.getByRole("textbox", { name: `Comment on ${RETRY}:17` });
    const mine = "Nit: rename MAX to MAX_ATTEMPTS so it says what it limits.";
    await box.fill(mine);
    await review.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
    const [write] = await githubWrites(page);
    expect(write.event).toBe("COMMENT");
    expect(write.comments.find((c) => c.line === 17)?.body).toBe(mine);
  });

  test("says what Post sends and that comments are Markdown, grows its boxes, wraps the diff and keeps the bar off the last line", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review.locator("[data-review-posts]")).toHaveText("Posts 2 inline comments and the summary as a comment review (not Approve or Request changes), at the reviewed commit. Nothing goes to GitHub until you post it here.");
    await expect(review.locator("[data-review-markdown]")).toHaveText("Markdown, formatted on GitHub");
    await review.getByRole("button", { name: `Drop comment on ${RETRY}:17` }).click();
    await expect(review.locator("[data-review-posts]")).toContainText("Posts 1 inline comment and the summary");

    // A long comment shows all its words: the box is as tall as its text.
    const box = review.getByRole("textbox", { name: `Comment on ${RETRY}:42` });
    await box.fill("The retry loop never backs off. ".repeat(12).trim());
    const fits = await box.evaluate((el: HTMLTextAreaElement) => el.scrollHeight <= el.clientHeight + 1 && el.clientHeight > 60);
    expect(fits).toBe(true);
    // Diff lines wrap inside the card rather than run off its edge.
    const hunk = review.locator("[data-review-hunk]").first();
    expect(await hunk.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await hunk.locator("[data-hunk-line] > span:last-child").first().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");

    // Scrolled to its end, the pinned bar sits under the card's last line, not over it.
    const last = review.locator("[data-review-posts]");
    await last.scrollIntoViewIfNeeded();
    await review.locator("[data-draft-actions]").scrollIntoViewIfNeeded();
    const [a, b] = [await last.boundingBox(), await review.locator("[data-draft-actions]").boundingBox()];
    expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 0.5);
  });
});

test.describe("Discuss with Pip on a review", () => {
  test("opens the pane with only this ticket's drafts, the rest folded, and the review talk in view", async ({ page }) => {
    const review = await reviewedDraft(page);
    await review.getByRole("button", { name: "Discuss with Pip" }).click();
    const drafts = pipPane(page).getByRole("region", { name: "Drafts" });
    await expect(pipPane(page).getByText("Ask Pip about this draft")).toBeInViewport();
    const others = drafts.locator("[data-other-tickets]");
    await expect(others).toHaveText(/^▸ \+\d+ drafts? on other tickets$/);
    await expect(others).toHaveAttribute("aria-expanded", "false");
    // Every card listed is about CA-402.
    for (const name of await drafts.getByRole("article").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.querySelector("h3")?.textContent ?? ""))) expect(name).toMatch(/CA-402|acme\/webshop#218/);
    const folded = Number((await others.textContent())!.match(/\d+/)![0]);
    const shown = await drafts.getByRole("article").count();
    await others.click();
    await expect(others).toHaveAttribute("aria-expanded", "true");
    await expect(drafts.getByRole("article")).toHaveCount(shown + folded);
    expect(await githubWrites(page)).toEqual([]);
  });
});

test.describe("the chip on a GitHub review draft", () => {
  test("reads Post, not Approve, while its group stays Approve", async ({ page }) => {
    test.setTimeout(90_000);
    await reviewedDraft(page);
    await peekSheet(page).getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
    await openAgents(page);
    await openNeedRow(page, "GitHub review");
    const row = needRow(page, "GitHub review");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-group", "approve");
    await expect(row.locator("[data-needs-you-chip]")).toHaveText("Post");
  });
});

test.describe("the review card once posted", () => {
  test("once posted, says where and at which commit it went, not to read and edit it before posting", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review.locator("[data-provenance=run]")).toContainText("read and edit it before you post");
    await review.getByRole("button", { name: "Approve" }).click();
    await expect(review.locator("[data-provenance=run]")).toContainText(/Posted to acme\/webshop#218 at [0-9a-f]{8}, as a comment review\./);
    await expect(review).not.toContainText("read and edit it before you post");
    await expect(review).not.toContainText("Nothing goes to GitHub until you post it here.");
  });
});

test.describe("the review card's preview", () => {
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

  await review.getByRole("button", { name: "Approve" }).click();
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

test("a token that can't post says why, and the preview opens the review draft without posting", async ({ page }) => {
  const review = await reviewedDraft(page, "&mockReviewAccess=none");
  await expect(review.locator('[data-review-access="cant-post"]')).toHaveText("This GitHub token can't post reviews on acme/webshop (it lacks write access to its pull requests).");
  await expect(review.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await expect(review.locator("[data-review-hunk]")).toHaveCount(2);
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[]; open: (url: string) => null };
    w.__opened = [];
    w.open = (url: string) => (w.__opened.push(String(url)), null);
  });
  await review.getByRole("button", { name: "Open on GitHub" }).click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(["https://github.com/acme/webshop/pull/218"]);
  await expect(page.getByRole("dialog", { name: /^Pull request / })).toHaveCount(0);
  await review.focus();
  await page.keyboard.press("Enter");
  const comment = review.getByRole("textbox", { name: `Comment on ${RETRY}:42` });
  await expect(comment).toBeFocused();
  await comment.fill("Still a draft");
  await page.keyboard.press("o");
  await expect(comment).toHaveValue("Still a drafto");
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toHaveLength(1);
  await page.getByRole("button", { name: "Close details" }).click();

  // From its preview card, a can't post it: the button opens the full draft with its diff hunks.
  const card = await previewCard(page);
  await expect(card.locator("[data-key-hint]")).toHaveText("e edit · d s skip · ↵ open");
  await card.getByRole("button", { name: "Review draft →" }).click();
  const reopened = page.locator("#peek-sheet").getByRole("article", { name: "GitHub review of acme/webshop#218" });
  await expect(reopened).toBeVisible();
  await expect(reopened.locator("[data-review-hunk]")).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toHaveLength(1);
  // The mock counts every attempted GitHub post, including one it refuses.
  await expect.poll(() => githubPostsTried(page)).toBe(0);
  await expect(page.getByText("Couldn't post that draft")).toHaveCount(0);
  await expect(page.getByText("can't write to pull requests")).toHaveCount(0);
  await expect(reopened.getByRole("alert")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-state", "pending");
  expect(await githubWrites(page)).toEqual([]);
});

test("after the pull request moves on the card warns before posting, and the post fails as Outdated with nothing written", async ({ page }) => {
  const review = await reviewedDraft(page);
  await expect(review.locator("[data-review-hunk]")).toHaveCount(2);
  expect(await movePullHead(page, "acme/webshop", 218)).toBe(true);
  await expect(review.locator("[data-review-moved]")).toHaveText(/^The pull request has moved on since this review: reviewed a1b2c3d4, now at moved\w*\. GitHub may mark these comments outdated\.$/);
  await review.getByRole("button", { name: "Approve" }).click();
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
  await expect(card.locator("[data-key-hint]")).toHaveText("↵ post this review · any other key cancels");
  await expect(card.locator("[data-preview-warning]")).toBeVisible();
  await page.keyboard.press("Enter");
  // The mock's push dropped the reviewed commit, so GitHub refuses it as outdated.
  await expect(review.locator("[data-review-outdated]")).toHaveText("Outdated");
  expect(await githubWrites(page)).toEqual([]);
});

test("a then Enter on the review's preview card posts it, once", async ({ page }) => {
  await reviewedDraft(page);
  const card = await previewCard(page);
  await expect(card.locator("[data-key-hint]")).toHaveText("a post · e edit · d s skip · ↵ open");
  await page.keyboard.press("a");
  await expect(card.locator("[data-key-hint]")).toHaveText("↵ post this review · any other key cancels");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  expect((await githubWrites(page))[0].comments.map((c) => `${c.path}:${c.line}`)).toEqual([`${RETRY}:42`, `${RETRY}:17`]);
});

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

  await review.getByRole("button", { name: "Approve" }).click();
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

  await review.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const [write] = await githubWrites(page);
  expect(write.comments.map((c) => [`${c.path}:${c.line}`, c.body])).toEqual([[AT_17, "My own words about MAX."]]);
});

test("one review of a pull request waits at a time, except one the person edited, and a posted one is never retired", async ({ page }) => {
  test.setTimeout(240_000);
  const first = await reviewedDraft(page);
  const [d1] = await pendingReviewDrafts(page);

  await first.getByRole("textbox", { name: "Review summary" }).fill("Mine: the retry loop still needs a back-off.");
  await first.getByRole("button", { name: "Discuss with Pip" }).click();
  await expect.poll(async () => (await reviewDrafts(page)).find((d) => d.id === d1.id)?.edited).toBe(true);

  // A newer review leaves the edited one standing beside it, and its card says so.
  const r2 = await reviewAgain(page);
  await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toHaveLength(2);
  const [d2] = await pendingReviewDrafts(page);
  expect(d2.runId).toBe(r2);
  expect((await reviewDrafts(page)).find((d) => d.id === d1.id)?.supersededBy).toBeNull();
  const second = peekSheet(page).locator(`article[data-draft="${d2.id}"]`);
  await expect(second.locator("[data-review-kept-older]")).toHaveText(/^An older review of #\d+ that you edited is still waiting; this one didn't replace it\.$/);

  // The person posts their edited one; the next review replaces the second and leaves the posted one as it is.
  await peekSheet(page).locator(`article[data-draft="${d1.id}"]`).getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const r3 = await reviewAgain(page);
  await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toEqual([r3]);
  const [d3] = await pendingReviewDrafts(page);
  const all = await reviewDrafts(page);
  expect(all.find((d) => d.id === d2.id)).toMatchObject({ state: "retired", supersededBy: d3.id });
  expect(all.find((d) => d.id === d1.id)).toMatchObject({ state: "applied", supersededBy: null });
  expect(new Set(all.map((d) => d.pull)).size).toBe(1);
  expect(await githubWrites(page)).toHaveLength(1);
});

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
  await allProjects(page);
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
