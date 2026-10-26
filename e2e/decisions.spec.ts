import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, closeWorkstreamSheet, askPermission, askPip, jiraWrites, mockAttached, mockRuns, needOfKind, needsPane, needsYouTray, openAgents, openApp, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream, workstreamEvents, openNeedOfKind } from "./support/app";

// Decisions only the person makes: a run's permission prompt answered in the app. Pull requests show only when a test says.
const SAMPLE = "runs=empty&prSurface=manual";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });
/** A permission's decision, in the pane beside the conversation. */
const asking = (page: Page) => needsPane(page).locator("[data-permission-ask]");
const count = (page: Page) => needsYouTray(page).locator("[data-needs-you-count]");

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Asks Pip for `what` on `key`, opens its draft and starts it, as the person does. */
async function startStep(page: Page, what: string, key = "CA-401") {
  await askPip(page, what);
  await settled(page);
  await runCards(page, key).last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
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
