import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, githubWrites, mockRuns, needOfKind, needsPane, openAgents, openApp, peekSheet, peekTicket, pendingReviewDrafts, pipConversation, pipPane, reviewDrafts, setBudget, startWorkstream, surfacePullRequests, workstreamEvents, openNeedOfKind } from "./support/app";

// Post the review as is, on an escalation (a review that still blocks after the automatic fix rounds): while its draft is
// open the card says why its choices wait; posting the draft resolves the escalation; discarding it brings the choices back.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Asks Pip for an investigation of `key`, opens its draft past the one-time safety sheet and starts it, as the person does. */
async function startInvestigation(page: Page, key = "CA-401") {
  await askPip(page, "investigate this");
  await settled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await runCards(page, key).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/** The newest run of `kind`, as the sample backend holds it. */
async function newest(page: Page, kind: string) {
  return (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
}

/** Waits for the next run of `kind` to have been started by a rule and returns it. */
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

/** Moves run `id` on to done: queued (or working again), launching, working, done. Only that run moves. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** Waits for a run of `kind` newer than `after` to have been started by a rule and returns it. */
async function startedAfter(page: Page, kind: string, after: string | null) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBe(after);
  return (await newest(page, kind))!;
}

/** The person approves the Gossamr Plan description draft on CA-401 from its peek, as written. */
async function approvePlan(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

/** A workstream in Manage with room for the whole chain: investigation, triage and plan, with the plan approved; returns the build. */
async function toBuild(page: Page) {
  // A GitHub connection that watches the build's repository, so each review leaves a review draft.
  await openApp(page, `${MANAGED}&mockRepos=12`);
  await startWorkstream(page, "CA-401");
  await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { autoTurns: 30, wakes: 40 });
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  await finish(page, (await started(page, "plan")).id);
  await approvePlan(page);
  return started(page, "build");
}

/** The build finishes its pass, its pull request shows, and the review the rule starts finishes (blocking, as the sample's do). Returns the review. */
async function buildAndReview(page: Page, build: string, after: string | null) {
  await finish(page, build);
  await surfacePullRequests(page);
  const review = (await startedAfter(page, "review", after)).id;
  await finish(page, review);
  return review;
}

const lines = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);
const escalationItem = (page: Page) => needOfKind(page, "escalation");
const escalationCard = (page: Page) => needsPane(page).getByRole("group", { name: "Review still blocks" });
const REASON = "Review draft open: post it from the draft";

/** A review that still blocks after two fix rounds: its card on Pip home, and the review draft it offers. */
async function escalated(page: Page) {
  test.setTimeout(240_000);
  const build = (await toBuild(page)).id;
  let review: string | null = null;
  for (let round = 0; round < 3; round++) {
    review = await buildAndReview(page, build, review);
    await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toEqual([review]);
  }
  await expect.poll(async () => (await lines(page, "fix_rounds_exhausted")).map((e) => e.runId)).toEqual([review]);
  await openAgents(page);
  await openNeedOfKind(page, "escalation");
  await expect(escalationItem(page)).toHaveCount(1);
  const [draft] = await pendingReviewDrafts(page);
  return { review: review!, draft, card: escalationCard(page) };
}

test("Post the review as is says why it waits while the draft is open, and the card leaves once the draft is posted", async ({ page }) => {
  const { review, draft, card } = await escalated(page);
  const choices = card.getByRole("button");
  await expect(choices).toHaveText(["Run another fix round", "I'll take it from here", "Post the review as is"]);
  await expect(card.getByText(REASON)).toHaveCount(0);

  await card.getByRole("button", { name: "Post the review as is" }).click();
  const open = needsPane(page).locator(`article[data-draft="${draft.id}"]`);
  await expect(open).toBeVisible();
  // Nothing is posted by choosing it, and the card says why its buttons wait, in words a screen reader gets too.
  expect(await githubWrites(page)).toEqual([]);
  await expect(card.locator("[data-escalation-draft-open]")).toContainText(REASON);
  for (const name of ["Run another fix round", "I'll take it from here", "Post the review as is"]) {
    const button = card.getByRole("button", { name });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(new RegExp(`${REASON}`));
  }
  await expect(escalationItem(page)).toHaveCount(1);

  // The person's own Post review: the escalation is resolved, audited, and the card leaves Needs you.
  await open.getByRole("button", { name: /^Post review/ }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  await expect(escalationItem(page)).toHaveCount(0);
  await expect(card).toHaveCount(0);
  expect((await lines(page, "escalation_posted")).map((e) => ({ actor: e.actor, runId: e.runId }))).toEqual([{ actor: "person", runId: review }]);
  expect(await lines(page, "escalation_taken")).toEqual([]);
  expect((await reviewDrafts(page)).find((d) => d.id === draft.id)).toMatchObject({ state: "applied" });
});

test("discarding the open review draft brings the card's choices back", async ({ page }) => {
  const { review, draft, card } = await escalated(page);
  await card.getByRole("button", { name: "Post the review as is" }).click();
  const open = needsPane(page).locator(`article[data-draft="${draft.id}"]`);
  await expect(open).toBeVisible();
  await expect(card.locator("[data-escalation-draft-open]")).toContainText(REASON);
  await expect(card.getByRole("button", { name: "Run another fix round" })).toBeDisabled();

  await open.getByRole("button", { name: "Discard" }).click();
  await expect.poll(async () => (await reviewDrafts(page)).find((d) => d.id === draft.id)?.state).toBe("skipped");
  await expect(card.locator("[data-escalation-draft-open]")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Run another fix round" })).toBeEnabled();
  await expect(card.getByRole("button", { name: "I'll take it from here" })).toBeEnabled();
  // The review has no draft waiting now, and the card says so rather than leaving the button grey without a reason.
  await expect(card.getByRole("button", { name: "Post the review as is" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Post the review as is" })).toHaveAttribute("title", "This review has no draft waiting.");
  await expect(escalationItem(page)).toHaveCount(1);
  expect(await githubWrites(page)).toEqual([]);
  expect(await lines(page, "escalation_posted")).toEqual([]);
  expect((await lines(page, "fix_rounds_exhausted")).map((e) => e.runId)).toEqual([review]);
});
