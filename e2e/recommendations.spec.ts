import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  backdateWorkstream,
  expandNeedsYou,
  heldBanner,
  holdAll,
  holdBySystem,
  homeComposer,
  homeRunCards,
  homeSettled,
  inlineStart,
  jiraWrites,
  mockRuns,
  needOfKind,
  needRow,
  needsPane,
  needsYouCount,
  needsYouRow,
  needsYouTray,
  openApp,
  openPipHome,
  peekSheet,
  peekTicket,
  pipConversation,
  paneSettled as settled,
  pipHome,
  pipPane,
  scriptNextRun,
  seedWorkstreamEvent,
  setBudget,
  startWorkstream,
  surfacePullRequests,
  wakes,
  workstreamEvents,
  workstreamRow,
  workstreamWeb,
  workstreamWebText,
} from "./support/app";

// Two product decisions (docs/needs-you.md): a hold the person chose is not a need, and the automatic budget is one unit,
// "automatic steps", whose running out is a Decide question in Needs you with "Allow 5 more" and "Switch to Advise".
// Then two more: Pip speaks up when a ticket is unclear (at intake, and as a hard stop after the triage), and a workstream
// where work is happening but Jira hasn't heard grows a cobweb.

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";

const toast = (page: Page) => page.locator("[data-toast]");
const undo = (page: Page) => toast(page).getByRole("button", { name: "Undo" });
const homeButton = (page: Page) => page.getByRole("button", { name: /^Pip home/ });
const nextLine = (page: Page) => pipPane(page).locator("[data-next-step]");
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const runCards = (page: Page, key: string) => pipPane(page).getByRole("article", { name: `Start an agent: ${key}` });
const actions = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);

/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(pipHome(page).getByRole("region", { name: "Conversation" }).locator("[data-pip-conversation]")).toHaveText(/^Workstream: CA-401 /);
}

/** Asks Pip for an investigation of CA-401, opens its draft past the one-time safety sheet and starts it, as the person does. */
async function startInvestigation(page: Page, key = "CA-401") {
  await settled(page);
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

const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Moves run `id` on to done once Pip has answered, so each finish gets a wake turn of its own. */
async function finish(page: Page, id: string) {
  await settled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** Waits for the next run of `kind` to have been started by a rule and returns it. */
async function started(page: Page, kind: string, after: string | null = null) {
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

/** Investigation, triage and plan, with the plan approved: returns the build the rules started. */
async function toBuild(page: Page) {
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  await finish(page, (await started(page, "plan")).id);
  await approvePlan(page);
  return started(page, "build");
}

/** A workstream on CA-401 allowed `steps` automatic steps, which the investigation and its triage use up: held for its budget. */
async function spent(page: Page, steps = 2) {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { autoTurns: steps });
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  await expect(heldBanner(page)).toHaveAttribute("data-held-banner", "budget");
}

test.describe("B2: a hold the person chose is not a need", () => {
  test("Hold: no need, no count, 'Held by you' with Resume in the header, and Undo still lifts it", async ({ page }) => {
    await openApp(page, "wsManage=1&runs=empty");
    await workstreamOnHome(page);
    await expect(needsYouCount(page)).toHaveText("0");
    const banner = pipHome(page).locator("[data-held-banner]");

    await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    await expect(banner).toContainText("Held by you");
    await expect(banner).toContainText("You chose this, so it is not in Needs you.");
    await expect(banner.getByRole("button", { name: "Resume" })).toBeVisible();
    // Nothing waits on the person: no row, no count anywhere, and the list says so.
    await expect(needOfKind(page, "hold")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(needsYouTray(page)).toContainText("Nothing needs you.");
    await expect(homeButton(page)).toHaveAccessibleName("Pip home");
    await expect(workstreamRow(page, "CA-401").locator("[data-status]")).toHaveText("· Held by you");
    await expect(workstreamRow(page, "CA-401").locator("[data-needs-you-badge]")).toHaveCount(0);

    // Undo of the hold works as before.
    await expect(toast(page)).toContainText("Held CA-401.");
    await undo(page).click();
    await expect(banner).toHaveCount(0);
    expect((await workstreamEvents(page)).map((e) => e.action).slice(-2)).toEqual(["held", "undone"]);

    // Resume is the way back from a hold that stands.
    await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Resume" }).click();
    await expect(banner).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
  });

  test("Hold all is the person's own too: 'Held by you (Hold all)', not counted", async ({ page }) => {
    await openApp(page, "wsManage=1&runs=empty");
    await workstreamOnHome(page);
    await holdAll(page, "button");
    const banner = pipHome(page).locator("[data-held-banner]");
    await expect(banner).toContainText("Held by you (Hold all)");
    await expect(banner.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(needOfKind(page, "hold")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(homeButton(page)).toHaveAccessibleName("Pip home");
  });

  test("a hold the system makes stays a need: it is counted, ranks in Unblock and opens Resume", async ({ page }) => {
    await openApp(page, "wsManage=1&runs=empty");
    await workstreamOnHome(page);
    await holdBySystem(page, "CA-401", "restart");
    const held = needOfKind(page, "hold");
    await expect(held).toHaveCount(1);
    await expect(held).toContainText("Held after a restart");
    await expect(needsYouCount(page)).toHaveText("1");
    await expect(homeButton(page)).toHaveAccessibleName("Pip home, 1 thing needs you");
    await held.click();
    await expect(needsPane(page)).toHaveAttribute("data-kind", "hold");
    await needsPane(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" }).click();
    await expect(needsYouCount(page)).toHaveText("0");
  });

  test("the system's other holds, a tripwire and the quota, are needs too", async ({ page }) => {
    await openApp(page, "wsManage=1&runs=empty");
    await workstreamOnHome(page);
    await holdBySystem(page, "CA-401", "tripwire:repeated_failure");
    await expect(needOfKind(page, "hold")).toContainText("Held: the same step failed twice");
    await expect(needsYouCount(page)).toHaveText("1");
  });
});

test.describe("B3: one budget unit, and running out becomes a question", () => {
  test("a managed workstream counts in 'automatic steps' only, never turns or wakes", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await expect(controls.locator("[data-steps-left]")).toHaveText("11 of 11 automatic steps left");
    await expect(controls).not.toContainText(/turns|wakes/i);
    // Near the limit the warning says it in the same unit, for the counter nearer its limit (here the wakes: 4 of 5).
    await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { wakes: 5 });
    await startInvestigation(page);
    const triage = await finish(page, (await newest(page, "investigate"))!.id).then(() => started(page, "triage"));
    await finish(page, triage.id);
    await finish(page, (await started(page, "plan")).id);
    await expect(wakes(page)).toHaveCount(3);
    await startInvestigation(page);
    await finish(page, (await newest(page, "investigate"))!.id);
    await expect(wakes(page)).toHaveCount(4);
    await expect(pipPane(page).locator('[data-budget="amber"]')).toHaveText("4 of 5 automatic steps used");
    await expect(controls).not.toContainText(/turns|wakes/i);
  });

  test("automatic fix rounds cost no step: a chain through two rounds and the exhausted review uses 5 of 11", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    const build = await toBuild(page);
    let review: string | null = null;
    for (let round = 0; round < 3; round++) {
      await finish(page, build.id);
      await surfacePullRequests(page);
      review = (await started(page, "review", review)).id;
      await finish(page, review);
    }
    expect(await actions(page, "fix_round_sent")).toHaveLength(2);
    await expect.poll(async () => (await actions(page, "fix_rounds_exhausted")).length).toBe(1);
    // Pip heard of all nine runs finishing, but only the investigation, triage, plan, the build's first finish and the last
    // review were steps: the reviews that sent a round and the builds that came back from one are free.
    await expect(wakes(page)).toHaveCount(9);
    await expect(pipPane(page).locator("[data-steps-left]")).toHaveText("6 of 11 automatic steps left");
    expect(await actions(page, "held")).toEqual([]);
    expect(await actions(page, "budget")).toEqual([]);
  });

  test("running out holds the workstream and asks in Needs you: a Decide need with Allow 5 more and Switch to Advise", async ({ page }) => {
    await spent(page);
    const title = "CA-401 used its 2 automatic steps";
    // The header says so in steps, and the Next line points at the question.
    await expect(heldBanner(page)).toContainText("Held: automatic steps used up. Resume to give it 2 more");
    await expect(heldBanner(page)).not.toContainText(/turns|wakes|write to Pip/);
    await expect(nextLine(page)).toHaveAttribute("data-next-step", "held");
    await expect(nextLine(page)).toHaveText("Next: the automatic steps are used up. Choose in Needs you: allow 5 more, or switch to Advise.");
    expect(await actions(page, "held").then((a) => a.map((e) => e.detail))).toEqual(["budget"]);

    // The Next line opens the need on Pip home.
    await nextLine(page).getByRole("button").click();
    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "budget");
    await expect(pane).toContainText(title);
    await expect(pane).toContainText("Pip and the automatic steps are paused until you decide.");
    await expect(pane).toContainText("2 of 2 automatic steps used");
    await expect(pane.getByRole("button", { name: "Allow 5 more" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "Switch to Advise" })).toBeVisible();
    await expect(pane).not.toContainText(/turns|wakes/i);
    // It is a Decide need, counted once.
    await expandNeedsYou(page, "CA-401");
    await expect(needRow(page, title)).toHaveAttribute("data-kind", "budget");
    await expect(needRow(page, title)).toHaveAttribute("data-group", "decide");
    await expect(needsYouRow(page, "CA-401").locator("[data-needs-you-chip]").first()).toHaveText("Decide");
    await expect(needsYouCount(page)).toHaveText(/^[1-9]\d*$/);
  });

  test("Allow 5 more raises the allowance by 5, resumes the workstream and writes the person's audit line", async ({ page }) => {
    await spent(page);
    await nextLine(page).getByRole("button").click();
    const before = Number(await needsYouCount(page).innerText());
    await needsPane(page).getByRole("button", { name: "Allow 5 more" }).click();

    await expect(needOfKind(page, "budget")).toHaveCount(0);
    await expect(pipHome(page).locator("[data-held-banner]")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText(String(before - 1));
    const events = await workstreamEvents(page);
    expect(events.filter((e) => e.action === "steps_allowed").map((e) => [e.actor, e.detail])).toEqual([["person", "5"]]);
    expect(events.filter((e) => e.action === "resumed").map((e) => [e.actor, e.detail])).toEqual([["person", "budget"]]);
    // What was spent stays: 2 of 7 now, 5 left.
    await expect(pipHome(page).locator("[data-steps-left]")).toHaveText("5 of 7 automatic steps left");
    expect(await jiraWrites(page)).toEqual([]);

    // The plan the triage queued goes on, and its finish wakes Pip again.
    const plan = await started(page, "plan");
    await settled(page);
    await finish(page, plan.id);
    await expect.poll(async () => (await actions(page, "wake")).map((e) => e.runId)).toContain(plan.id);
  });

  test("Switch to Advise answers the question without lifting the hold or allowing anything", async ({ page }) => {
    await spent(page);
    await nextLine(page).getByRole("button").click();
    await needsPane(page).getByRole("button", { name: "Switch to Advise" }).click();
    await expect(needOfKind(page, "budget")).toHaveCount(0);
    expect((await actions(page, "mode_set")).map((e) => [e.actor, e.detail]).pop()).toEqual(["person", "advise"]);
    // The hold stays for Resume, which the header offers; nothing was allowed.
    await expect(pipHome(page).locator("[data-held-banner]")).toContainText("Held: automatic steps used up");
    expect(await actions(page, "steps_allowed")).toEqual([]);
    await expect(toast(page)).toContainText("CA-401 to Advise");
  });
});

// Pip speaks up when a ticket is unclear.

const VAGUE = "CA-408";
const VAGUE_WORDS = "CA-408 doesn't say what done looks like, what's in or out of scope, or who is waiting on it.";

/** A managed workstream on the sample's vague ticket, its investigation and the triage a rule started after it finished: the triage says it is not ready to plan. Left on Pip home, on its row. */
async function unclear(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, VAGUE);
  await startInvestigation(page, VAGUE);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  await openPipHome(page);
  await workstreamRow(page, VAGUE).click();
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("D1: Pip speaks up when a ticket is unclear", () => {
  test("its first turn in a workstream on a vague ticket says plainly what is missing, and a clear ticket gets no such line", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, VAGUE);
    await settled(page);
    await askPip(page, "where do we stand?");
    await settled(page);
    await expect(pipPane(page)).toContainText(VAGUE_WORDS);
    // Only its first turn does: the second doesn't say it again.
    await askPip(page, "where do we stand now?");
    await settled(page);
    expect(((await pipPane(page).innerText()).match(/doesn't say what done looks like/g) ?? []).length).toBe(1);

    // A ticket with a real description is not remarked on.
    await startWorkstream(page, "DEVOPS-471");
    await settled(page);
    await askPip(page, "where do we stand?");
    await settled(page);
    await expect(pipPane(page)).not.toContainText("doesn't say what done looks like");
  });

  test("a triage that says the ticket isn't ready stops the plan: a Decide need lists the questions, with the three choices", async ({ page }) => {
    await unclear(page);
    // Nothing planned, though the triage recommended a plan: the rule is gated on the verdict.
    expect(await newest(page, "plan")).toBeNull();
    expect((await actions(page, "autostart")).map((e) => e.detail)).toEqual([expect.stringMatching(/^investigate_triage after /)]);

    const need = needOfKind(page, "readiness");
    await expect(need).toContainText("R2 left these questions open: What does done look like for CA-408?");
    await expect(need).toHaveAttribute("data-group", "decide");
    await expect(needsYouRow(page, VAGUE).locator("[data-needs-you-chip]").first()).toHaveText("Decide");
    await need.click();
    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "readiness");
    await expect(pane).toContainText("CA-408 isn't clear enough to plan");
    const questions = pane.locator("[data-readiness-questions] li");
    await expect(questions).toHaveCount(3);
    await expect(questions.nth(0)).toContainText("What does done look like for CA-408?");
    await expect(pane).toContainText("No plan starts until you choose.");
    for (const name of ["Ask the reporter", "I'll answer", "Plan anyway"]) await expect(pane.getByRole("button", { name })).toBeVisible();
    // The Next line says what the workstream waits on.
    await expect(pipHome(page).locator("[data-next-step]")).toContainText("waiting on you.");
    await expect(pipHome(page).locator("[data-next-step]")).toContainText("What does done look like for CA-408?");
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("Ask the reporter drafts a comment to the reporter for approval: nothing is posted before it, and the need is answered", async ({ page }) => {
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    await expect(toast(page)).toContainText("Drafted a comment to the reporter with the open questions. It is posted only when you approve it.");
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    expect(await newest(page, "plan")).toBeNull();
    const asked = (await actions(page, "readiness_asked"))[0];
    expect([asked.actor, asked.runId]).toEqual(["person", (await newest(page, "triage"))!.id]);

    // The draft is an ordinary one: Gossamr's, addressed to the reporter, listing the questions, waiting in Needs you.
    await expandNeedsYou(page, VAGUE);
    const row = needRow(page, "Questions for the reporter");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-group", "approve");
    await row.click();
    await expect(needsPane(page)).toContainText("Gossamr drafted a comment to the reporter of CA-408 from R2's open questions; it is posted only when you approve it.");
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(draft.locator('[data-created-by="gossamr"]')).toHaveText("Drafted by Gossamr");
    await expect(draft).toContainText("@Mette Lund");
    await expect(draft).toContainText("Before CA-408 can be planned");
    await expect(draft).toContainText("What does done look like for CA-408?");
    await expect(draft).toContainText("Who asked for this, and who is waiting on it?");
    expect(await jiraWrites(page)).toEqual([]);
    // Approving it is the one thing that posts, and it goes to the ticket whole.
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", VAGUE]]);
  });

  test("I'll answer opens the workstream's conversation with the questions quoted in the composer, and starts nothing", async ({ page }) => {
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    await expect(homeComposer(page)).toHaveValue(/^R2's open questions about CA-408: “What does done look like for CA-408\?/);
    await expect(homeComposer(page)).toHaveValue(/“What is in scope and what is out\?” · “Who asked for this, and who is waiting on it\?”\. My answers: $/);
    await expect(homeComposer(page)).toBeFocused();
    expect((await actions(page, "readiness_answered")).map((e) => e.actor)).toEqual(["person"]);
    expect(await newest(page, "plan")).toBeNull();
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("Plan anyway records the person's override and the plan starts as the rule would have; under a hold it waits for Resume", async ({ page }) => {
    await unclear(page);
    // A hold is respected: the override is on record, and the plan starts only once the workstream is set going.
    await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    await expect(pipHome(page).locator("[data-held-banner]")).toContainText("Held by you");
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Plan anyway" }).click();
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    const line = (await actions(page, "readiness_overridden"))[0];
    expect([line.actor, line.runId]).toEqual(["person", (await newest(page, "triage"))!.id]);
    await expect.poll(async () => await newest(page, "plan")).toBeNull();

    await pipHome(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" }).click();
    const plan = await started(page, "plan");
    const triage = (await newest(page, "triage"))!;
    expect((await actions(page, "autostart")).map((e) => e.detail)).toContain(`triage_plan after ${triage.id}`);
    expect(plan.id).toBeTruthy();
    expect(await jiraWrites(page)).toEqual([]);
  });

  test("a later triage that says ready resolves the need, and the plan starts as it always did", async ({ page }) => {
    await unclear(page);
    const first = (await newest(page, "triage"))!;
    // The person asks for another triage (Pip drafts it from the investigation); it finishes saying the ticket is ready.
    await scriptNextRun(page, "triage", { ready: true });
    await homeComposer(page).fill("triage it");
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    const review = await inlineStart(page, homeRunCards(page, VAGUE).last());
    await review.getByRole("button", { name: "Start agent" }).click();
    const again = await started(page, "triage", first.id);
    await finish(page, again.id);
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
    const plan = await started(page, "plan");
    expect(plan.id).toBeTruthy();
  });
});


// A workstream where work is happening but Jira hasn't heard grows a cobweb.

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

test.describe("D2: a workstream where work is happening but Jira hasn't heard", () => {
  test("grows a cobweb on its row only once agents or Pip worked since the person's last post, says so in words, and is never a need", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, MANAGED);
    // CA-403: quiet and nothing happens. CA-402: an agent starts. CA-401: Pip will take a turn.
    await startWorkstream(page, "CA-403");
    await startWorkstream(page, "CA-402");
    await startInvestigation(page, "CA-402");
    // The agent started working: a run queued is not one that started.
    await advanceRuns(page, 2, (await newest(page, "investigate"))!.id);
    await startWorkstream(page, "CA-401");
    // The last post to Jira was 6 days ago in two of them; CA-403 never posted and opened 6 days ago.
    await seedWorkstreamEvent(page, "CA-402", { actor: "person", action: "review_posted", at: ago(6) });
    await seedWorkstreamEvent(page, "CA-401", { actor: "person", action: "review_posted", at: ago(6) });
    await backdateWorkstream(page, "CA-403", 6);
    await openPipHome(page);

    // Six days without a word to Jira, but nothing happened in CA-403 or CA-401 since: no cobweb. The ticket list's own covers a ticket nobody touches.
    for (const key of ["CA-403", "CA-401"]) {
      await expect(workstreamRow(page, key)).toBeVisible();
      await expect(workstreamWeb(page, key)).toHaveCount(0);
      await expect(workstreamRow(page, key)).not.toHaveAttribute("data-wither", /.+/);
    }
    // An agent started in CA-402 (and Pip answered the request): work since the post, so its row has the web.
    const row = workstreamRow(page, "CA-402");
    const words = /^No Jira update for 6 days \(1 run and 1 Pip turn since\)$/;
    await expect(workstreamWeb(page, "CA-402")).toHaveCount(1);
    await expect(row).toHaveAttribute("data-wither", "3");
    await expect(row).toHaveAttribute("title", words);
    await expect(workstreamWebText(page, "CA-402")).toHaveText(words);
    // A screen reader gets the same words with the row; the drawing is hidden from it.
    await expect(row).toHaveAccessibleName(/No Jira update for 6 days \(1 run and 1 Pip turn since\)$/);
    await expect(workstreamWeb(page, "CA-402")).toHaveAttribute("aria-hidden", "true");
    await expect(row).toHaveClass(/\bws-wither ws-wither-3\b/);

    // Pip taking a turn in CA-401 is work too: its row grows one, counting that turn.
    await workstreamRow(page, "CA-401").click();
    await homeComposer(page).fill("where do we stand?");
    await homeComposer(page).press("Enter");
    await homeSettled(page);
    await expect(workstreamWeb(page, "CA-401")).toHaveCount(1);
    await expect(workstreamWebText(page, "CA-401")).toHaveText("No Jira update for 6 days (1 Pip turn since)");
    await expect(workstreamWeb(page, "CA-403")).toHaveCount(0);

    // It is a look, not a duty: no need, no count anywhere.
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(needsYouTray(page)).toContainText("Nothing needs you.");
    await expect(homeButton(page)).toHaveAccessibleName("Pip home");
    await expect(needOfKind(page, "readiness")).toHaveCount(0);
  });

  test("starts from when the workstream opened until the person posts, and a post to Jira clears it", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-402");
    await backdateWorkstream(page, "CA-402", 8);
    await startInvestigation(page, "CA-402");
    await finish(page, (await newest(page, "investigate"))!.id);
    await openPipHome(page);
    const web = workstreamWeb(page, "CA-402");
    // No post yet: the clock runs from when it opened, 8 days ago.
    await expect(web).toHaveCount(1);
    await expect(workstreamRow(page, "CA-402")).toHaveAttribute("data-wither", "4");
    await expect(workstreamWebText(page, "CA-402")).toHaveText(/^No Jira update for 8 days \(\d+ runs? and \d+ Pip turns? since\)$/);

    // The person approves the comment the investigation drafted: that is a post, and the clock starts again.
    await workstreamRow(page, "CA-402").click();
    await needOfKind(page, "draft").click();
    await needsPane(page).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", "CA-402"]]);
    await expect(web).toHaveCount(0);
    await expect(workstreamRow(page, "CA-402")).not.toHaveAttribute("data-wither", /.+/);
    await expect(workstreamWebText(page, "CA-402")).toHaveCount(0);
  });
});
