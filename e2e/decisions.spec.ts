import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPermission,
  askPip,
  expandAllNeeds,
  expectToast,
  githubWrites,
  jiraWrites,
  mockAttached,
  mockRuns,
  needOfKind,
  needsPane,
  needsYouTray,
  openApp,
  openPipHome,
  peekSheet,
  peekTicket,
  pendingReviewDrafts,
  pipConversation,
  pipHome,
  pipPane,
  reviewDrafts,
  setBudget,
  startWorkstream,
  surfacePullRequests,
  workstreamEvents,
} from "./support/app";

// Decisions only the person makes, in a workstream in Manage mode (`wsManage=1`): a run's permission prompt answered
// in the app, and a review that still blocks after the automatic fix rounds. Pull requests show only when a test says.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });
/** A permission's decision, in the pane beside the conversation. */
const asking = (page: Page) => needsPane(page).locator("[data-permission-ask]");
const count = (page: Page) => needsYouTray(page).locator("[data-needs-you-count]");

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

/** Moves run `id` on to `state` one step at a time, after Pip has answered. */
async function moveTo(page: Page, id: string, state: string, steps: number) {
  await settled(page);
  for (let i = 0; i < steps; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe(state);
}

/** Waits for the next run of `kind` to have been started by a rule and returns it. */
async function started(page: Page, kind: string) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBeNull();
  return (await newest(page, kind))!;
}

/** Investigation, triage and plan, with the plan approved: returns the build the rules started, working. */
async function workingBuild(page: Page) {
  await startInvestigation(page);
  await moveTo(page, (await newest(page, "investigate"))!.id, "done", 3);
  await moveTo(page, (await started(page, "triage")).id, "done", 3);
  await moveTo(page, (await started(page, "plan")).id, "done", 3);
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  const build = await started(page, "build");
  await moveTo(page, build.id, "working", 2);
  return (await mockRuns(page)).find((r) => r.id === build.id)!;
}

const audited = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action).map((e) => ({ actor: e.actor, runId: e.runId, detail: e.detail }));

test("Allow once on a Build opens it in Terminal for that exact command, and a push Gossamr forbids offers no Allow", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  const build = await workingBuild(page);
  const push = `git push -u origin worktree-${build.name}`;
  // The plan's description the person approved is the only write so far; answering the prompt adds none.
  const written = await jiraWrites(page);
  await askPermission(page, build.id, `approve Bash: ${push}`);

  await openPipHome(page);
  await expandAllNeeds(page);
  const item = needOfKind(page, "permission");
  await expect(item).toContainText("R4 wants to run `git push -u origin");
  await item.click();
  await expect(needsPane(page)).toContainText("The run stays paused; nothing else in CA-401 moves.");
  await expect(asking(page)).toBeVisible();
  await expect(asking(page)).toContainText("R4 wants to run this command:");
  await expect(asking(page).locator("code")).toHaveText(push);
  const allow = asking(page).getByRole("button", { name: "Allow once in Terminal" });
  await expect(allow).toHaveClass(/bg-ws-pip/);
  await expect(asking(page).getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(asking(page).getByRole("button", { name: "Stop the run (abandons it)" })).toBeVisible();
  await expect(asking(page)).toContainText("Claude Code takes a yes only in its own prompt.");

  // From the keyboard: the command's Copy, then Tab to Allow once and Enter.
  await asking(page).getByRole("button", { name: "Copy the command" }).focus();
  await page.keyboard.press("Tab");
  await expect(allow).toBeFocused();
  await page.keyboard.press("Enter");
  const sent = asking(page).getByRole("status");
  await expect(sent).toHaveText("Opened in Terminal, command copied. Choose Yes there for this command only.");
  await expect(sent).toBeFocused();
  await expect(allow).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(push);
  expect(await mockAttached(page)).toEqual([build.id]);
  expect(await audited(page, "permission_allowed_in_terminal")).toEqual([{ actor: "person", runId: build.id, detail: push }]);
  // The person answers in Terminal now: the need says so until it is answered, and nothing about what was approved changed.
  await expect(needsPane(page)).toContainText("R4 waits for your Yes in Terminal for `git push -u origin");
  await expect(needsPane(page)).toHaveAttribute("data-needs-pane", `run:${build.id}`);
  const after = (await mockRuns(page)).find((r) => r.id === build.id)!;
  expect(after).toMatchObject({ state: "needsPermission", digest: build.digest });

  // It asks for a push Gossamr forbids a Build: the rule, and no Allow.
  await askPermission(page, build.id, "approve Bash: git push origin main");
  await expect(asking(page).locator("code")).toHaveText("git push origin main");
  await expect(asking(page)).toContainText(`A Build pushes only its own branch, worktree-${build.name}, to origin: Gossamr doesn't allow this.`);
  await expect(asking(page).getByRole("button", { name: /Allow/ })).toHaveCount(0);
  await expect(asking(page).getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(needsPane(page)).toContainText("R4 wants to run `git push origin main`.");
  expect(await mockAttached(page)).toEqual([build.id]);
  expect(await jiraWrites(page)).toEqual(written);

  // On its card in Agents, Stop asks first, as the sheet does: one click beside Deny doesn't abandon the run.
  await page.getByRole("button", { name: /^Agents/ }).click();
  const onCard = page.locator(`main article[data-run-id="${build.id}"]`);
  await onCard.getByRole("button", { name: "Stop the run (abandons it)" }).click();
  const confirm = onCard.getByRole("group", { name: "Stop this run" });
  await expect(confirm).toContainText("Stop R4? It abandons the run.");
  await expect(confirm.getByRole("button", { name: "Yes, stop" })).toBeFocused();
  await confirm.getByRole("button", { name: "Keep going" }).click();
  await expect(confirm).toHaveCount(0);
  expect((await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("needsPermission");
  await onCard.getByRole("button", { name: "Stop the run (abandons it)" }).click();
  await onCard.getByRole("group", { name: "Stop this run" }).getByRole("button", { name: "Yes, stop" }).click();
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("stopped");
});

test("Deny on a read-only run, which is never offered Allow: Claude carries on without it", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const run = (await newest(page, "investigate"))!;
  await moveTo(page, run.id, "working", 2);
  await askPermission(page, run.id, "approve Bash: rm -rf node_modules");

  await openPipHome(page);
  await expandAllNeeds(page);
  const item = needOfKind(page, "permission");
  await expect(item).toContainText("R1 wants to run `rm -rf node_modules`.");
  const before = Number(await count(page).textContent());
  await item.click();
  await expect(asking(page)).toContainText("R1 wants to run this command:");
  await expect(asking(page).locator("code")).toHaveText("rm -rf node_modules");
  await expect(asking(page)).toContainText("This run is read-only: Claude Code refuses this.");
  await expect(asking(page).getByRole("button", { name: /Allow/ })).toHaveCount(0);
  await expect(asking(page).getByRole("button")).toHaveText(["Copy", "Deny", "Stop the run (abandons it)"]);

  await asking(page).getByRole("button", { name: "Deny" }).click();
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === run.id)?.state).toBe("working");
  expect(await audited(page, "permission_denied")).toEqual([{ actor: "person", runId: run.id, detail: "rm -rf node_modules" }]);
  // Dealt with, it leaves Needs you, and the pane has moved on from it.
  await expect(needOfKind(page, "permission")).toHaveCount(0);
  await expect(count(page)).toHaveText(String(before - 1));
  expect(await mockAttached(page)).toEqual([]);
  expect(await jiraWrites(page)).toEqual([]);
});

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
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
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
/** The review's three choices in the pane; the conversation's own card is the same one. */
const escalationCard = (page: Page) => needsPane(page).getByRole("group", { name: "Review still blocks" });

test("a review that still blocks after two fix rounds comes to the person with three choices, each theirs alone", async ({ page }) => {
  test.setTimeout(240_000);
  const build = (await toBuild(page)).id;
  let review: string | null = null;
  for (let round = 0; round < 3; round++) {
    review = await buildAndReview(page, build, review);
    // One review of the pull request waits for the person: the newest.
    await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toEqual([review]);
  }
  await expect.poll(async () => (await lines(page, "fix_rounds_exhausted")).map((e) => e.runId)).toEqual([review]);
  expect(await lines(page, "fix_round_sent")).toHaveLength(2);

  await openPipHome(page);
  await expandAllNeeds(page);
  await expect(escalationItem(page)).toHaveCount(1);
  await expect(escalationItem(page)).toContainText("The review still blocks after 2 fix rounds.");
  await escalationItem(page).click();
  const card = escalationCard(page);
  await expect(card).toContainText(/R\d+ still blocks after 2 fix rounds\. What next\?/);
  await expect(card.getByRole("button")).toHaveText(["Run another fix round", "I'll take it from here", "Post the review as is"]);
  await expect(card.getByRole("button", { name: "Run another fix round" })).toBeFocused();

  // The review draft folded into this need is under the choices, not a second need in the list.
  const [waiting] = await pendingReviewDrafts(page);
  const draft = needsPane(page).locator(`article[data-draft="${waiting.id}"]`);
  await expect(draft).toBeVisible();
  await expect(needsYouTray(page).locator("[data-needs-you-need][data-kind=\"review\"], [data-needs-you-group][data-kind=\"review\"]")).toHaveCount(0);
  // Post the review as is: nothing goes to GitHub until the draft's own Post review.
  await card.getByRole("button", { name: "Post the review as is" }).click();
  await expect(draft.getByRole("button", { name: "Post review" })).toBeFocused();
  expect(await githubWrites(page)).toEqual([]);
  await expect(escalationItem(page)).toHaveCount(1);

  // Run another fix round: the person's, past the cap, recorded as theirs; the item goes.
  const passes = (await mockRuns(page)).find((r) => r.id === build)!.passes;
  await card.getByRole("button", { name: "Run another fix round" }).click();
  // The toast also holds its Dismiss button's text, so the line is matched without an end anchor.
  await expectToast(page, /^Fix round sent to R\d+\./);
  expect((await lines(page, "fix_round_person")).map((e) => ({ actor: e.actor, runId: e.runId, detail: e.detail }))).toEqual([{ actor: "person", runId: build, detail: `after ${review}` }]);
  const rounds = await lines(page, "fix_round_sent");
  expect(rounds.map((e) => e.actor)).toEqual(["supervisor", "supervisor", "person"]);
  expect((await mockRuns(page)).find((r) => r.id === build)).toMatchObject({ state: "working", passes: passes + 1 });
  await expect(escalationItem(page)).toHaveCount(0);
  await expect(card).toHaveCount(0);

  // The next review blocks too: the need is back and needs a fresh click; the rule sent no third round of its own.
  review = await buildAndReview(page, build, review);
  await expandAllNeeds(page);
  await expect(escalationItem(page)).toHaveCount(1);
  await escalationItem(page).click();
  expect(await lines(page, "fix_round_sent")).toHaveLength(3);
  await expect(card.getByRole("button")).toHaveText(["Run another fix round", "I'll take it from here", "Post the review as is"]);

  // I'll take it from here: Advise, and nothing else changes.
  const before = { runs: await mockRuns(page), drafts: await pendingReviewDrafts(page), jira: await jiraWrites(page) };
  await card.getByRole("button", { name: "I'll take it from here" }).click();
  const over = pipHome(page).getByRole("status").filter({ hasText: "Over to you" });
  await expectToast(page, "Over to you: this workstream is on Advise now.");
  await expect(pipHome(page).getByRole("switch", { name: "Manage this workstream" })).toHaveAttribute("aria-checked", "false");
  expect((await lines(page, "escalation_taken")).map((e) => ({ actor: e.actor, runId: e.runId }))).toEqual([{ actor: "person", runId: review }]);
  await expect(escalationItem(page)).toHaveCount(0);
  expect(await mockRuns(page)).toEqual(before.runs);
  expect(await pendingReviewDrafts(page)).toEqual(before.drafts);
  expect(await jiraWrites(page)).toEqual(before.jira);
  expect(await githubWrites(page)).toEqual([]);

  // Manage on again: the review taken over stays the person's. No false "on Advise now", and the tray and the card agree.
  await pipHome(page).getByRole("switch", { name: "Manage this workstream" }).click();
  await expect(pipHome(page).getByRole("switch", { name: "Manage this workstream" })).toHaveAttribute("aria-checked", "true");
  await expect(over).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await expect(escalationItem(page)).toHaveCount(0);
});

test("one review of a pull request waits at a time, except one the person edited, and a posted one is never retired", async ({ page }) => {
  test.setTimeout(240_000);
  const build = (await toBuild(page)).id;
  const r1 = await buildAndReview(page, build, null);
  const [d1] = await pendingReviewDrafts(page);
  expect(d1.runId).toBe(r1);

  // The person edits the first review while the build is at its fix round; saving it for the PR view posts nothing.
  await peekTicket(page, "CA-401");
  const first = peekSheet(page).locator(`article[data-draft="${d1.id}"]`);
  await first.getByRole("textbox", { name: "Review summary" }).fill("Mine: the retry loop still needs a back-off.");
  await first.getByRole("button", { name: "Open PR view" }).click();
  const view = page.getByRole("dialog", { name: /^Pull request / });
  await expect(view).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect.poll(async () => (await reviewDrafts(page)).find((d) => d.id === d1.id)?.edited).toBe(true);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);

  // The second review leaves the edited one standing beside it, and its card says so.
  const r2 = await buildAndReview(page, build, r1);
  await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toEqual([r2, r1]);
  const [d2] = await pendingReviewDrafts(page);
  expect((await reviewDrafts(page)).find((d) => d.id === d1.id)?.supersededBy).toBeNull();
  expect((await lines(page, "draft_kept_edited")).map((e) => e.detail)).toEqual([d2.id]);
  await peekTicket(page, "CA-401");
  const second = peekSheet(page).locator(`article[data-draft="${d2.id}"]`);
  await expect(second.locator("[data-review-kept-older]")).toHaveText(/^An older review of #\d+ that you edited is still waiting; this one didn't replace it\.$/);

  // The person posts their edited one; the third review replaces the second and leaves the posted one as it is.
  await first.getByRole("button", { name: "Post review" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);
  const r3 = await buildAndReview(page, build, r2);
  await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toEqual([r3]);
  const [d3] = await pendingReviewDrafts(page);
  const all = await reviewDrafts(page);
  expect(all.find((d) => d.id === d2.id)).toMatchObject({ state: "retired", supersededBy: d3.id });
  expect(all.find((d) => d.id === d1.id)).toMatchObject({ state: "applied", supersededBy: null });
  expect(new Set(all.map((d) => d.pull)).size).toBe(1);
  expect(await githubWrites(page)).toHaveLength(1);
});
