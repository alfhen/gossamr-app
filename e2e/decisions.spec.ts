import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, closeWorkstreamSheet, askPermission, askPip, githubWrites, jiraWrites, mockAttached, mockRuns, needOfKind, needsPane, needsYouTray, openAgents, openApp, peekSheet, peekTicket, pendingReviewDrafts, pipConversation, pipPane, reviewDrafts, reviewedDraft, startAgent, startWorkstream, workstreamEvents, openNeedOfKind } from "./support/app";

// Decisions only the person makes: a run's permission prompt answered in the app. Pull requests show only when a test says.
const SAMPLE = "runs=empty&prSurface=manual";

/** A permission's decision, in the pane beside the conversation. */
const asking = (page: Page) => needsPane(page).locator("[data-permission-ask]");
const count = (page: Page) => needsYouTray(page).locator("[data-needs-you-count]");

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Asks Pip for `what`, which starts the agent. */
async function startStep(page: Page, what: string) {
  await askPip(page, what);
  await settled(page);
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

/** Investigation, triage and plan, each started by the person, with the plan approved and its build started: returns that build, working. */
async function workingBuild(page: Page) {
  for (const [what, kind] of [["investigate this", "investigate"], ["triage this", "triage"], ["plan this", "plan"]] as const) {
    await startStep(page, what);
    await moveTo(page, (await newest(page, kind))!.id, "done", 3);
  }
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await startStep(page, "build it");
  const build = (await newest(page, "build"))!;
  await moveTo(page, build.id, "working", 2);
  return (await mockRuns(page)).find((r) => r.id === build.id)!;
}

const audited = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action).map((e) => ({ actor: e.actor, runId: e.runId, detail: e.detail }));

test("Allow once on a Build opens it in Terminal for that exact command, and a push Gossamr forbids offers no Allow", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  const build = await workingBuild(page);
  const push = `git push -u origin worktree-${build.name}`;
  // The plan's description the person approved is the only write so far; answering the prompt adds none.
  const written = await jiraWrites(page);
  await askPermission(page, build.id, `approve Bash: ${push}`);

  await openAgents(page);
  await openNeedOfKind(page, "permission");
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
  await expect(asking(page)).toContainText(`A Build may push only its own branch, worktree-${build.name}, to origin, without force: Gossamr doesn't allow this push.`);
  await expect(asking(page).getByRole("button", { name: /Allow/ })).toHaveCount(0);
  await expect(asking(page).getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(needsPane(page)).toContainText("R4 wants to run `git push origin main`.");
  expect(await mockAttached(page)).toEqual([build.id]);
  expect(await jiraWrites(page)).toEqual(written);

  // Deny on a Build asks first; an open confirm belongs to the request it was opened for, so a new request closes it.
  await asking(page).getByRole("button", { name: "Deny" }).click();
  const denyConfirm = asking(page).getByRole("group", { name: "Deny this request" });
  await expect(denyConfirm).toContainText("Deny this?");
  await askPermission(page, build.id, "approve Bash: git status");
  await expect(asking(page)).toContainText("git status");
  await expect(denyConfirm).toHaveCount(0);
  expect((await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("needsPermission");

  // On its card in Agents, Stop asks first, as the sheet does: one click beside Deny doesn't abandon the run.
  await closeWorkstreamSheet(page);
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
  await openApp(page, SAMPLE);
  await startWorkstream(page, "CA-401");
  await startStep(page, "investigate this");
  const run = (await newest(page, "investigate"))!;
  await moveTo(page, run.id, "working", 2);
  await askPermission(page, run.id, "approve Bash: rm -rf node_modules");

  await openAgents(page);
  await openNeedOfKind(page, "permission");
  const item = needOfKind(page, "permission");
  await expect(item).toContainText("R1 wants to run `rm -rf node_modules`.");
  const before = Number(await count(page).textContent());
  await item.click();
  await expect(asking(page)).toContainText("R1 wants to run this command:");
  await expect(asking(page).locator("code")).toHaveText("rm -rf node_modules");
  await expect(asking(page)).toContainText("This run is read-only, so this command would be refused anyway.");
  await expect(asking(page).getByRole("button", { name: /Allow/ })).toHaveCount(0);
  await expect(asking(page).getByRole("button")).toHaveText(["Copy", "Deny", "Stop the run (abandons it)"]);

  await asking(page).getByRole("button", { name: "Deny" }).click();
  // A read-only run was refused anyway: one click tells it no, with no confirm step.
  await expect(asking(page).getByRole("group", { name: "Deny this request" })).toHaveCount(0);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === run.id)?.state).toBe("working");
  expect(await audited(page, "permission_denied")).toEqual([{ actor: "person", runId: run.id, detail: "rm -rf node_modules" }]);
  // Dealt with, it leaves Needs you, and the pane has moved on from it.
  await expect(needOfKind(page, "permission")).toHaveCount(0);
  await expect(count(page)).toHaveText(String(before - 1));
  expect(await mockAttached(page)).toEqual([]);
  expect(await jiraWrites(page)).toEqual([]);
});

/** Another Review of CA-402's build is started, as Pip does, and moved to done; its draft then waits in CA-402's peek. */
async function reviewAgain(page: Page) {
  await page.keyboard.press("Escape");
  const build = (await mockRuns(page)).find((r) => r.kind === "build" && r.key === "CA-402")!;
  const id = await startAgent(page, "CA-402", "review", { fromRun: build.id });
  await advanceRuns(page, 3, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
  await peekTicket(page, "CA-402");
  return id;
}

test("one review of a pull request waits at a time, except one the person edited, and a posted one is never retired", async ({ page }) => {
  test.setTimeout(240_000);
  const first = await reviewedDraft(page);
  const [d1] = await pendingReviewDrafts(page);

  // The person edits the first review; saving it for the PR view posts nothing.
  await first.getByRole("textbox", { name: "Review summary" }).fill("Mine: the retry loop still needs a back-off.");
  await first.getByRole("button", { name: "Open PR view" }).click();
  const view = page.getByRole("dialog", { name: /^Pull request / });
  await expect(view).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
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
  await peekSheet(page).locator(`article[data-draft="${d1.id}"]`).getByRole("button", { name: "Post review" }).click();
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
