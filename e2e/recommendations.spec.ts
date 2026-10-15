import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  advanceRuns,
  agentsSettled,
  askPip,
  backdateWorkstream,
  editTicket,
  expandAllNeeds,
  expandNeedsYou,
  heldBanner,
  holdAll,
  holdBySystem,
  homeComposer,
  homeConversationRegion,
  homeRunCards,
  homeSettled,
  inlineStart,
  githubWrites,
  jiraWrites,
  mockRuns,
  manageSwitch,
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
  stepRail,
  startWorkstream,
  surfacePullRequests,
  wakes,
  workstreamEvents,
  workstreamRow,
  workstreamWeb,
  workstreamWebText,
  expectToast,
  still,
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
/** The toasts, the open pane, the hold and the audit, as text: what a failed Allow 5 more leaves behind for its log. */
async function budgetState(page: Page): Promise<string> {
  const toasts = await page.locator("[data-toast]").allInnerTexts();
  const pane = await needsPane(page).innerText({ timeout: 1_000 }).catch(() => "(no pane)");
  const held = await pipHome(page).locator("[data-held-banner]").getAttribute("data-held-banner", { timeout: 1_000 }).catch(() => null);
  const events = (await workstreamEvents(page)).map((e) => `${e.actor} ${e.action} ${e.detail ?? ""}`.trim());
  return [`toasts: ${JSON.stringify(toasts)}`, `held banner: ${held ?? "none"}`, `pane: ${JSON.stringify(pane)}`, `audit: ${JSON.stringify(events)}`].join("\n");
}

/** Opens the budget question from the Next line and waits for the pane to stop moving, so a click lands on its button. */
async function openBudgetNeed(page: Page) {
  await nextLine(page).getByRole("button").click();
  await still(needsPane(page).getByRole("button", { name: "Allow 5 more" }));
}

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
    await expect(workstreamRow(page, "CA-401").locator("[data-status]")).toHaveText("Held by you");
    await expect(workstreamRow(page, "CA-401").locator('[data-status="needs-you"]')).toHaveCount(0);

    // Undo of the hold works as before.
    await expectToast(page, "Held CA-401.");
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
    await expect(heldBanner(page)).toContainText("Held: automatic steps used up");
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
    await openBudgetNeed(page);
    const before = Number(await needsYouCount(page).innerText());
    await needsPane(page).getByRole("button", { name: "Allow 5 more" }).click();

    // If this fails in CI, the log says what the page held, since CI's traces can't be read from here.
    await expect(needOfKind(page, "budget"))
      .toHaveCount(0)
      .catch(async (e: Error) => {
        throw new Error(`${e.message}\n\nWhat the page held when the budget need stayed:\n${await budgetState(page)}`);
      });
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
    await openBudgetNeed(page);
    await needsPane(page).getByRole("button", { name: "Switch to Advise" }).click();
    await expect(needOfKind(page, "budget")).toHaveCount(0);
    expect((await actions(page, "mode_set")).map((e) => [e.actor, e.detail]).pop()).toEqual(["person", "advise"]);
    // The hold stays for Resume, which the header offers; nothing was allowed.
    await expect(pipHome(page).locator("[data-held-banner]")).toContainText("Held: automatic steps used up");
    expect(await actions(page, "steps_allowed")).toEqual([]);
    await expectToast(page, "CA-401 to Advise");
  });

  test("the header's banner for a budget hold offers Allow 5 more and Switch to Advise, never Resume", async ({ page }) => {
    await spent(page);
    const banner = heldBanner(page);
    await expect(banner.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await expect(banner.getByRole("button", { name: "Switch to Advise" })).toBeVisible();
    await banner.getByRole("button", { name: "Allow 5 more" }).click();
    await expect(heldBanner(page)).toHaveCount(0);
    const events = await workstreamEvents(page);
    expect(events.filter((e) => e.action === "steps_allowed").map((e) => [e.actor, e.detail])).toEqual([["person", "5"]]);
    expect(events.filter((e) => e.action === "budget_reset")).toEqual([]);
    await expect(pipPane(page).locator("[data-steps-left]")).toHaveText("5 of 7 automatic steps left");
  });

  test("the banner's Switch to Advise answers the question, and the hold it leaves is lifted with Resume", async ({ page }) => {
    await spent(page);
    await heldBanner(page).getByRole("button", { name: "Switch to Advise" }).click();
    await expect(needOfKind(page, "budget")).toHaveCount(0);
    await expect(heldBanner(page).getByRole("button", { name: "Allow 5 more" })).toHaveCount(0);
    await expect(heldBanner(page).getByRole("button", { name: "Resume" })).toBeVisible();
  });

  test("Switch to Advise, Resume and back to Manage asks Allow 5 more again, with the spent count unchanged", async ({ page }) => {
    await spent(page);
    const left = pipPane(page).locator("[data-steps-left]");
    const before = await left.innerText();
    await heldBanner(page).getByRole("button", { name: "Switch to Advise" }).click();
    await expect(needOfKind(page, "budget")).toHaveCount(0);
    await heldBanner(page).getByRole("button", { name: "Resume" }).click();
    await expect(heldBanner(page)).toHaveCount(0);
    expect(await actions(page, "budget_reset")).toEqual([]);

    // Manage again: nothing was granted, so the question is back.
    await pipPane(page).getByRole("switch", { name: "Manage this workstream" }).click();
    await expect(heldBanner(page)).toHaveAttribute("data-held-banner", "budget");
    await expect(heldBanner(page).getByRole("button", { name: "Allow 5 more" })).toBeVisible();
    await expect(left).toHaveText(before);
    await nextLine(page).getByRole("button").click();
    await expect(needsPane(page)).toHaveAttribute("data-kind", "budget");
    await expect(needsPane(page).getByRole("button", { name: "Allow 5 more" })).toBeVisible();
    expect((await actions(page, "held")).map((e) => [e.actor, e.detail]).pop()).toEqual(["supervisor", "budget"]);
    expect(await actions(page, "steps_allowed")).toEqual([]);
  });

  test("a double click on Allow 5 more allows once and shows no error", async ({ page }) => {
    await spent(page);
    await openBudgetNeed(page);
    await needsPane(page).getByRole("button", { name: "Allow 5 more" }).dblclick();
    await expect(needOfKind(page, "budget")).toHaveCount(0);
    expect((await actions(page, "steps_allowed")).length).toBe(1);
    await expect(toast(page).filter({ hasText: /Couldn't/ })).toHaveCount(0);
  });
});

// Pip speaks up when a ticket is unclear.

const VAGUE = "CA-408";
const VAGUE_WORDS = "CA-408 may be unclear: it has a very short description, doesn't say what done looks like, doesn't say what's in or out of scope, and doesn't say who is waiting on it.";
/** A description that says what done looks like, what is in scope and who is waiting, which Pip's check reads as clear. */
const CLEAR_WORDS = "The retry should cap at five attempts. Only the webhook handler is in scope. The payments team is waiting on it. Done when a provider outage no longer produces a retry burst.";

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
    // Only its first turn does: the second doesn't say it again. (The notice above the conversation says it once more, in its own box, the status pill's detail a third time, the pill's hint for screen readers, which explains the phrase, a fourth, and the notice's own status line a fifth.)
    await askPip(page, "where do we stand now?");
    await settled(page);
    expect(((await pipPane(page).innerText()).match(/may be unclear/g) ?? []).length).toBe(5);
    await expect(pipPane(page).locator("[data-clarity-notice]")).toContainText("CA-408 may be unclear");

    // A ticket whose description says what done looks like, what is in scope and who is waiting is not remarked on.
    await editTicket(page, "DEVOPS-471", { description: CLEAR_WORDS });
    await startWorkstream(page, "DEVOPS-471");
    await settled(page);
    await askPip(page, "where do we stand?");
    await settled(page);
    await expect(pipPane(page)).not.toContainText("DEVOPS-471 may be unclear");
  });

  test("a triage that says the ticket isn't ready stops the plan: a Decide need lists the questions, with the three choices", async ({ page }) => {
    await unclear(page);
    // Nothing planned, though the triage recommended a plan: the rule is gated on the verdict.
    expect(await newest(page, "plan")).toBeNull();
    expect((await actions(page, "autostart")).map((e) => e.detail)).toEqual([expect.stringMatching(/^investigate_triage after /)]);

    const need = needRow(page, "isn't clear enough to plan");
    // Open by default, the group's row is its name and count; the need under it says what it is.
    await expect(need).toContainText("CA-408 isn't clear enough to plan");
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
    await expectToast(page, "Here is the comment to the reporter. Nothing is posted until you press Post comment.");
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
    await expect(draft).toContainText("Before work on CA-408 starts");
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
    await expect(row).toHaveAccessibleDescription(/No Jira update for 6 days \(1 run and 1 Pip turn since\)$/);
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

// Layout and explanations (dogfood B1, B4, B6, B10): Needs you is Pip home's main left column and the screen is named; a
// decision shows once, in the pane, which scrolls alone and never hides text behind its action bar; Runs across every
// workstream stays in the timeline; and the mode switch and the first permission prompt explain themselves.

const home = (page: Page) => pipHome(page);
const boxOf = async (loc: Locator) => (await loc.boundingBox())!;
const timelineBody = (page: Page) => homeConversationRegion(page).locator("[data-timeline]");

test.describe("B1: Needs you is the main left column on Pip home", () => {
  test("the screen is named, Needs you heads the column with the workstreams under it, and both are usable at 1440x900", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await openPipHome(page);
    await expect(home(page).getByRole("heading", { level: 1, name: "Pip home" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

    const needs = needsYouTray(page);
    const list = home(page).getByRole("navigation", { name: "Workstreams" });
    // Needs you is a region of its own, no longer inside the workstreams' navigation.
    await expect(list.getByRole("region", { name: "Needs you" })).toHaveCount(0);
    const [n, w, c] = [await boxOf(needs), await boxOf(list), await boxOf(homeConversationRegion(page))];
    expect(n.y + n.height).toBeLessThanOrEqual(w.y + 1);
    // Needs you comes first and shows every need it has without scrolling; the workstreams take what it leaves (G7 in round 8).
    expect(await needs.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(4);
    expect(n.x + n.width).toBeLessThanOrEqual(c.x + 1);
    expect(n.width).toBeGreaterThanOrEqual(280);
    expect(w.y + w.height).toBeLessThanOrEqual(900);
    // Both are usable: a need row and a workstream row are on screen, and the timeline sits beside them.
    await expect(needsYouRow(page, "General")).toBeVisible();
    await expect(workstreamRow(page, "General")).toBeVisible();
    await expect(timelineBody(page)).toBeVisible();

    // A title wraps to two lines rather than being cut to one (the existing two-line clamp).
    const clamp = await needsYouRow(page, "General").locator("[data-needs-you-head]").first().evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-line-clamp"));
    expect(clamp).toBe("2");
    const nowrap = await needsYouRow(page, "General").locator("[data-needs-you-head]").first().evaluate((el) => getComputedStyle(el).whiteSpace);
    expect(nowrap).not.toBe("nowrap");
  });

  test("the list keeps its keys: F6 between regions, j and k, Enter opens the decision, Esc closes it", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await openPipHome(page);
    const first = needsYouTray(page).locator("[data-needs-you-group]").first();
    await first.focus();
    const inList = () => page.evaluate(() => !!document.activeElement?.closest('[data-pip-home-column="list"]'));
    await page.keyboard.press("j");
    expect(await inList()).toBe(true);
    await expect(first).not.toBeFocused();
    await page.keyboard.press("k");
    await expect(first).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(needsPane(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(needsPane(page)).toHaveCount(0);
    await first.focus();
    await page.keyboard.press("F6");
    await expect(workstreamRow(page, "General")).toBeFocused();
  });
});

test.describe("B4: a decision shows once", () => {
  test("a draft open in the pane is not a card on the timeline as well, and is one again when the pane closes", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await openPipHome(page);
    await needsYouRow(page, "General").locator("[data-needs-you-group]").click();
    const pane = needsPane(page);
    await expect(pane).toBeVisible();
    const card = pane.locator("article[data-draft]").first();
    await expect(card).toBeVisible();
    const id = (await card.getAttribute("data-draft"))!;
    // One card of it on the whole screen: in the pane. The timeline says it in a line, and the rail has none.
    await expect(home(page).locator(`article[data-draft="${id}"]`)).toHaveCount(1);
    await expect(timelineBody(page).locator(`article[data-draft="${id}"]`)).toHaveCount(0);
    await expect(timelineBody(page).locator(`[data-timeline-entry="draft:${id}"]`)).toHaveCount(1);
    await expect(stepRail(page).locator(`[data-draft="${id}"]`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(home(page).locator(`article[data-draft="${id}"]`)).toHaveCount(1);
    await expect(timelineBody(page).locator(`article[data-draft="${id}"]`)).toHaveCount(1);
  });

  test("the pane is the only scroller in its place, and the draft's action bar is in the flow, never over the text", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await openPipHome(page);
    await needsYouRow(page, "General").locator("[data-needs-you-group]").click();
    const pane = needsPane(page);
    const bar = pane.locator("[data-draft-actions]").first();
    await expect(bar).toBeVisible();
    // Long enough to scroll, and scrolled to the middle: a sticky bar would sit over the draft's text.
    await pane.evaluate((el) => (el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)));
    const overlaps = await pane.evaluate((el) => {
      const actions = el.querySelector<HTMLElement>("[data-draft-actions]")!;
      const before = actions.previousElementSibling as HTMLElement | null;
      return { position: getComputedStyle(actions).position, gap: before ? actions.getBoundingClientRect().top - before.getBoundingClientRect().bottom : 0 };
    });
    expect(overlaps.position).toBe("static");
    expect(overlaps.gap).toBeGreaterThanOrEqual(-1);
    // No scroller inside the pane but the pane, bar a long diff, which scrolls in a box of its own so the bar under it stays in view (round 10, G10).
    const nested = await pane.evaluate((el) => Array.from(el.querySelectorAll("*")).filter((e) => !e.matches("[data-diff]") && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).length);
    expect(nested).toBe(0);
    // The last of the draft is reachable above its bar: scrolled to the end, the bar is the pane's last line.
    await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const [p, b] = [await boxOf(pane), await boxOf(bar)];
    expect(b.y + b.height).toBeLessThanOrEqual(p.y + p.height + 1);
  });

  test("a hold the system made is the pane's banner alone, not the rail's as well, and the header stays in view", async ({ page }) => {
    await openApp(page, "wsManage=1&runs=empty");
    await workstreamOnHome(page);
    await holdBySystem(page, "CA-401", "restart");
    await expect(home(page).locator("[data-held-banner]")).toHaveCount(1);
    await expect(stepRail(page).locator("[data-held-banner]")).toHaveCount(1);
    await needOfKind(page, "hold").click();
    await expect(needsPane(page).locator("[data-held-banner]")).toHaveCount(1);
    await expect(home(page).locator("[data-held-banner]")).toHaveCount(1);
    await expect(stepRail(page).locator("[data-held-banner]")).toHaveCount(0);
    // Closed, the rail shows it again.
    await page.keyboard.press("Escape");
    await expect(stepRail(page).locator("[data-held-banner]")).toHaveCount(1);
  });
});

test.describe("B6: Runs across every workstream stays in the timeline", () => {
  test("Runs with Every workstream lists runs from every workstream on Pip home, labelled, and never swaps to Agents", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "prSurface=manual&wsManage=1&pipPace=1");
    await startWorkstream(page, "CA-401");
    await startInvestigation(page);
    const run = (await newest(page, "investigate"))!;
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    const filter = (name: string) => home(page).getByRole("group", { name: "Timeline filter" }).getByRole("button", { name: new RegExp(`^${name}\\b`) });
    const scope = (name: string) => home(page).getByRole("group", { name: "Timeline scope" }).getByRole("button", { name });
    await filter("Runs").click();
    await scope("Every workstream").click();
    // Still Pip home: the heading is Pip home's, there is no Agents screen, both buttons are pressed.
    await expect(page.getByRole("heading", { level: 1, name: "Pip home" })).toBeVisible();
    await expect(page.locator("main").getByRole("heading", { name: "Agents", exact: true })).toHaveCount(0);
    await expect(filter("Runs")).toHaveAttribute("aria-pressed", "true");
    await expect(scope("Every workstream")).toHaveAttribute("aria-pressed", "true");
    // Runs from every workstream and General: this workstream's, and the sample's own in General.
    const entries = timelineBody(page).locator('[data-timeline-entry][data-kind="run"]');
    await expect(entries.first()).toBeVisible();
    expect(await entries.count()).toBeGreaterThan(1);
    await expect(timelineBody(page).locator(`article[data-run-id="${run.id}"]`)).toBeVisible();
    await expect(entries.locator("[data-timeline-workstream]", { hasText: /^CA-401$/ }).first()).toBeVisible();
    await expect(entries.locator('[data-timeline-workstream="general"]').first()).toBeVisible();
    // The scope is what the person left it: the Pip pane's link says the same without leaving Pip home.
    await scope("This workstream").click();
    await expect(timelineBody(page).locator('[data-timeline-workstream="general"]')).toHaveCount(0);
  });

  test("the Agents screen stays reachable, by its tab and by ⌘K, as the operations view", async ({ page }) => {
    await openApp(page, "prSurface=manual");
    await openPipHome(page);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: /^Stop all/ })).toBeVisible();
    await expect(main.locator("[data-agents-scope]")).toHaveCount(0);
    // ⌘K: Open Agents from Pip home.
    await openPipHome(page);
    await expect(main.getByRole("heading", { name: "Agents", exact: true })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("agents");
    const dialog = page.getByRole("dialog", { name: /Search|Jump|command/i }).or(page.getByRole("dialog")).first();
    await expect(dialog.getByRole("option").first()).toContainText("Open Agents");
    await page.keyboard.press("Enter");
    await expect(main.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    // And ⌘K's timeline commands stay on Pip home, with no hint sending Runs elsewhere.
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("Timeline: Runs");
    const option = page.getByRole("option", { name: /^Timeline: Runs/ });
    await expect(option).toBeVisible();
    await expect(option).not.toContainText("Agents");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Pip home" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Timeline filter" }).getByRole("button", { name: /^Runs\b/ })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("B10: the switch and the first permission prompt explain themselves", () => {
  test("a line under the Manage switch says what the mode does, and changes with it, on Pip home's header and the Pip pane's", async ({ page }) => {
    await openApp(page, "wsManage=1&runs=empty");
    await workstreamOnHome(page);
    const MANAGE = "Pip manages: it starts the next step by itself and drafts what's next; nothing reaches Jira without you.";
    const ADVISE = "Pip advises: it answers when asked and starts nothing by itself.";
    const homeLine = stepRail(page).locator("[data-mode-line]");
    await expect(homeLine).toHaveText(MANAGE);
    // Directly under the switch's row.
    const row = stepRail(page).getByRole("switch", { name: "Manage this workstream" });
    // The line follows the row that holds the switch, before anything else of the header, and is below it on screen.
    expect(await homeLine.evaluate((el, sw) => !!el.previousElementSibling?.contains(document.evaluate(sw, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue), '//*[@role="switch"][@aria-label="Manage this workstream"]')).toBe(true);
    const [r, l] = [await boxOf(row), await boxOf(homeLine)];
    expect(l.y).toBeGreaterThanOrEqual(r.y + r.height - 2);
    await row.click();
    await expect(homeLine).toHaveText(ADVISE);
    await expect(homeLine).toHaveAttribute("data-mode-line", "advise");
    await row.click();
    await expect(homeLine).toHaveText(MANAGE);

    // The same in the Pip pane's header, on the workspace.
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
    const paneLine = pipPane(page).locator("[data-mode-line]");
    await expect(paneLine).toHaveText(MANAGE);
    await manageSwitch(page).click();
    await expect(paneLine).toHaveText(ADVISE);
  });

  test.describe("Allow once and Deny", () => {
    // The first prompt the person ever sees: the config's seeded profile has it dismissed, so this one starts without.
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        if (sessionStorage.getItem("explainer-unseeded")) return;
        sessionStorage.setItem("explainer-unseeded", "1");
        const prefs = JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}");
        localStorage.setItem("gossamr-prefs", JSON.stringify({ ...prefs, permissionExplainerSeen: false }));
      });
    });

    test("the first permission prompt explains both buttons above them with a Got it that is kept, and no later prompt repeats it", async ({ page }) => {
      await openApp(page, "runs=kinds&prSurface=manual");
      await openPipHome(page);
      await expandAllNeeds(page);
      await needOfKind(page, "permission").click();
      const ask = needsPane(page).locator("[data-permission-ask]");
      await expect(ask).toBeVisible();
      const explainer = ask.locator("[data-permission-explainer]");
      await expect(explainer).toBeVisible();
      await expect(explainer).toContainText("Deny tells the agent no, and it carries on without it.");
      // Above the buttons it explains.
      const [e, d] = [await boxOf(explainer), await boxOf(ask.locator("[data-permission-decisions]"))];
      expect(e.y + e.height).toBeLessThanOrEqual(d.y + 1);
      // Got it dismisses it; the keyboard lands on the prompt's own first answer.
      await explainer.getByRole("button", { name: "Got it" }).click();
      await expect(explainer).toHaveCount(0);
      await expect(ask.locator("[data-permission-decisions] button").first()).toBeFocused();
      // It stays dismissed across a reload.
      await page.reload();
      await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
      await openPipHome(page);
      await expandAllNeeds(page);
      await needOfKind(page, "permission").click();
      await expect(needsPane(page).locator("[data-permission-ask]")).toBeVisible();
      await expect(page.locator("[data-permission-explainer]")).toHaveCount(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}").permissionExplainerSeen)).toBe(true);
    });
  });
});


// Keyboard and polish (dogfood B5, B7, B8, B9, B11, B12): F6 reaches every region of Pip home and j/k treat every group alike;
// a command word outranks the tickets it also matches; one label for approving drafts together, whose preview opens in the
// pane; the timeline's fix rounds, failure headings and order; Ctrl+0 from a card's button; the launcher clear of Agents.

/** The region of Pip home the keyboard is in, as F6 names them. */
const regionNow = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return null;
    if (a.closest("[data-needs-pane]")) return "pane";
    if (a.closest("[data-needs-you]")) return "needs";
    if (a.closest("[data-clarity-notice]")) return "notice";
    if (a.closest('nav[aria-label="Workstreams"]')) return "workstreams";
    if (a.closest("[data-timeline-scope-shown]")) return "timeline";
    if (a.closest('[data-pip-home-column="rail"]')) return "rail";
    return a.id === "pip-input" ? "composer" : null;
  });

/** Presses `key` and waits for the keyboard to be in `region`. */
async function pressTo(page: Page, key: string, region: string) {
  await page.keyboard.press(key);
  await expect.poll(() => regionNow(page), { message: `after ${key}` }).toBe(region);
}

/** A workstream on CA-401 on Pip home with two drafted comments of Pip's waiting in Needs you: one group of two needs, which may go together. */
async function twoDrafts(page: Page) {
  await openApp(page, MANAGED);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("2");
}

test.describe("B5: F6 reaches every region of Pip home", () => {
  test("in order: Needs you, the workstreams, the timeline, the open decision, the steps, the composer; Shift+F6 and Cmd/Ctrl+[ ] go the other way", async ({ page }) => {
    await twoDrafts(page);
    const group = needsYouRow(page, "CA-401").locator("[data-needs-you-group]");
    await group.focus();
    // Enter opens the decision, and the keyboard is in it.
    await page.keyboard.press("Enter");
    await expect(needsPane(page)).toBeVisible();
    await expect.poll(() => regionNow(page)).toBe("pane");

    // CA-401's thin description shows the clarity notice, which is a stop of its own at the top of the steps column.
    for (const region of ["notice", "rail", "composer", "needs", "workstreams", "timeline", "pane"]) await pressTo(page, "F6", region);
    for (const region of ["timeline", "workstreams", "needs", "composer", "rail", "notice", "pane"]) await pressTo(page, "Shift+F6", region);
    // The same with the bracket keys, and the timeline lands on an entry (or the timeline itself while it has none).
    await pressTo(page, "ControlOrMeta+BracketRight", "notice");
    await pressTo(page, "ControlOrMeta+BracketLeft", "pane");
    await pressTo(page, "Shift+F6", "timeline");
    await expect(page.locator("[data-timeline]")).toHaveCount(1);

    // The workstreams land on the selected one, Needs you on the row open in the pane.
    await pressTo(page, "Shift+F6", "workstreams");
    await expect(workstreamRow(page, "CA-401")).toBeFocused();
    await pressTo(page, "Shift+F6", "needs");
    await expect(group).toBeFocused();

    // With the decision closed it is passed by.
    await page.keyboard.press("Escape");
    await expect(needsPane(page)).toHaveCount(0);
    await expect.poll(() => regionNow(page)).toBe("needs");
    for (const region of ["workstreams", "timeline", "notice", "rail", "composer", "needs"]) await pressTo(page, "F6", region);
  });

  test("with no workstream there is no steps region and no decision, and the timeline is still a stop", async ({ page }) => {
    await openApp(page, MANAGED);
    await openPipHome(page);
    await expect(homeComposer(page)).toBeFocused();
    for (const region of ["needs", "workstreams", "timeline", "composer"]) await pressTo(page, "F6", region);
  });
});

test.describe("B5: j and k move row by row through the visible rows, and a collapsed group is one row", () => {
  test("a collapsed group is one row; an open one is its own row, then one for each of its other needs, and Enter or o opens its top need", async ({ page }) => {
    await twoDrafts(page);
    const group = needsYouRow(page, "CA-401").locator("[data-needs-you-group]");
    const key = (await group.getAttribute("data-need-key"))!;
    // Pip home opens a group by default while its needs fit: fold this one first.
    await needsYouRow(page, "CA-401").locator("[data-needs-you-more]").click();
    const focusedKey = () => page.evaluate(() => document.activeElement?.getAttribute("data-need-key") ?? null);
    await group.focus();
    await expect(group).toHaveAttribute("aria-expanded", "false");
    // Folded: the next row is the workstreams'.
    await page.keyboard.press("j");
    await expect(workstreamRow(page, "General")).toBeFocused();
    await page.keyboard.press("k");
    await expect(group).toBeFocused();

    // o expands it and opens its top need, as Enter does; Esc comes back to the row.
    await page.keyboard.press("o");
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(needsPane(page)).toHaveAttribute("data-needs-pane", key);
    await page.keyboard.press("Escape");
    await expect(group).toBeFocused();

    // Open: its own row stands for its top need, so the next stop is the other need, then the workstreams, and back.
    const rows = needsYouRow(page, "CA-401").locator("[data-needs-you-need]");
    await expect(rows).toHaveCount(2);
    await page.keyboard.press("j");
    await expect.poll(focusedKey).not.toBe(key);
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("j");
    await expect(workstreamRow(page, "General")).toBeFocused();
    await page.keyboard.press("k");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(group).toBeFocused();
    await page.keyboard.press("k");
    await expect(group).toBeFocused();
  });
});

test.describe("B7: a command word outranks the tickets it also matches", () => {
  const options = async (page: Page, query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type(query);
    const list = page.getByRole("dialog", { name: "Command palette" }).getByRole("option");
    await expect(list.first()).toBeVisible();
    return list;
  };

  test("'runs', 'timeline' and 'agents' find their commands first, and a ticket with the word in its title follows", async ({ page }) => {
    await openApp(page, MANAGED);
    await agentsSettled(page);
    let list = await options(page, "runs");
    await expect(list.first()).toContainText("Timeline: Runs");
    const names = await list.allInnerTexts();
    expect(names.findIndex((n) => n.includes("Worker runs out of memory"))).toBeGreaterThan(0);
    await page.keyboard.press("Escape");

    list = await options(page, "timeline");
    await expect(list.first()).toContainText(/^.?\s*Timeline: /);
    await page.keyboard.press("Escape");

    list = await options(page, "agents");
    expect(await list.first().innerText()).toMatch(/Open Agents|Open Pip home/);
    await expect(list.first()).not.toContainText(/[A-Z]+-\d+/);
    await page.keyboard.press("Escape");
  });

  test("fuzzy ticket search still works, and a typed ticket key still leads", async ({ page }) => {
    await openApp(page, MANAGED);
    await agentsSettled(page);
    let list = await options(page, "retry failed payment");
    await expect(list.first()).toContainText("DEVOPS-471");
    await page.keyboard.press("Escape");
    list = await options(page, "out of memory");
    await expect(list.first()).toContainText("DEVOPS-477");
    await page.keyboard.press("Escape");
    list = await options(page, "devops-471");
    await expect(list.first()).toContainText("DEVOPS-471");
  });
});

test.describe("B8: one label for approving drafts together, and its preview opens in the decision pane", () => {
  test("'Approve N safe drafts' opens the preview and its one confirm in the pane, not inside the list; Cancel and Esc keep the drafts", async ({ page }) => {
    await twoDrafts(page);
    const ws = needsYouRow(page, "CA-401");
    await expandNeedsYou(page, "CA-401");
    const batch = ws.getByRole("button", { name: "Approve 2 safe drafts" });
    await expect(batch).toHaveCount(1);
    await expect(pipHome(page).getByRole("button", { name: /^Approve these/ })).toHaveCount(0);
    await batch.click();

    const pane = needsPane(page);
    await expect(pane).toHaveAttribute("data-kind", "batch");
    await expect(pane.locator("[data-needs-pane-title]")).toHaveText("Approve 2 safe drafts");
    await expect(pane).toContainText("Nothing is posted until you choose.");
    await expect(pane.locator("[data-needs-you-batch-preview] li")).toHaveCount(2);
    await expect(needsYouTray(page).locator("[data-needs-you-batch-preview]")).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Yes, approve 2" })).toBeFocused();
    expect(await jiraWrites(page)).toEqual([]);

    // Esc from the confirm keeps every draft, closes the pane and returns to the row.
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    expect(await jiraWrites(page)).toEqual([]);
    await expect(needsYouCount(page)).toHaveText("2");
    await expect(ws.locator("[data-needs-you-group]")).toBeFocused();

    // Choosing a need's own row replaces the preview with its decision.
    await batch.click();
    await expect(pane).toHaveAttribute("data-kind", "batch");
    await needRow(page, /Draft comment/).first().click();
    await expect(needsPane(page)).not.toHaveAttribute("data-kind", "batch");
    await expect(needsPane(page).locator("[data-needs-you-batch-preview]")).toHaveCount(0);

    // The palette's entry opens the same pane, and the confirm approves exactly the two it showed.
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("approve all safe");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name: /Approve all safe drafts in CA-401/ }).click();
    await expect(needsPane(page)).toHaveAttribute("data-kind", "batch");
    await needsPane(page).getByRole("button", { name: "Yes, approve 2" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment", "comment"]);
    await expect(needsYouCount(page)).toHaveText("0");
    await expect(needsPane(page).locator("[data-batch-outcome]")).toContainText("Approved 2");
  });
});

test.describe("B9: the timeline's fix rounds, failure headings and order", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const entryTexts = (page: Page) => page.locator("[data-timeline-entry]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));

  test("each fix round has a line of its own: the rules' say 'automatically', the person's does not", async ({ page }) => {
    await openApp(page, MANAGED);
    await startWorkstream(page, "CA-401");
    await startInvestigation(page);
    const run = (await newest(page, "investigate"))!;
    await seedWorkstreamEvent(page, "CA-401", { actor: "supervisor", action: "fix_round_sent", at: minutesAgo(3), runId: run.id, detail: "120" });
    await seedWorkstreamEvent(page, "CA-401", { actor: "supervisor", action: "fix_round_sent", at: minutesAgo(2), runId: run.id, detail: "120" });
    await seedWorkstreamEvent(page, "CA-401", { actor: "person", action: "fix_round_sent", at: minutesAgo(1), runId: run.id, detail: "120" });
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect.poll(async () => (await entryTexts(page)).filter((t) => t.startsWith("Fix round"))).toEqual(["Fix round 1 sent to R1 automatically", "Fix round 2 sent to R1 automatically", "Fix round 3 sent to R1"]);
  });

  test("a failed run's heading is short and its own message is smaller type under it", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await openPipHome(page);
    const failed = homeConversationRegion(page).locator('[data-timeline-entry][data-kind="run"][data-phase="failed"]').first();
    await expect(failed).toBeVisible();
    const heading = await failed.getAttribute("aria-label");
    expect(heading).toMatch(/^Investigate( R\d+)? failed$/);
    const detail = failed.locator("[data-timeline-detail]");
    await expect(detail).toHaveCount(1);
    const message = (await detail.innerText()).trim();
    expect(message.length).toBeGreaterThan(0);
    expect(heading).not.toContain(message);
    await expect(failed.locator("[data-timeline-line]")).toContainText(heading!);
    // Smaller type than the heading.
    const size = (loc: Locator) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(await size(detail)).toBeLessThan(await size(failed.locator("[data-timeline-line] > span.min-w-0, [data-timeline-line] button").first()));
  });

  test("two automatic rounds then the person's posting: each round after the review that sent it, and the posted review after the review run", async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page, `${MANAGED}&mockRepos=12`);
    await startWorkstream(page, "CA-401");
    await setBudget(page, (await workstreamEvents(page))[0].workstreamId, { autoTurns: 30, wakes: 40 });
    const build = (await toBuild(page)).id;
    let review: string | null = null;
    for (let round = 0; round < 3; round++) {
      await finish(page, build);
      await surfacePullRequests(page);
      review = (await started(page, "review", review)).id;
      await finish(page, review);
      // The rules send the build back for each of the first two; the third review is the person's.
      await expect.poll(async () => (await actions(page, round < 2 ? "fix_round_sent" : "fix_rounds_exhausted")).length).toBe(round < 2 ? round + 1 : 1);
    }
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect.poll(async () => (await entryTexts(page)).filter((t) => t.startsWith("Fix round"))).toEqual(["Fix round 1 sent to R4 automatically", "Fix round 2 sent to R4 automatically"]);
    const texts = async () => entryTexts(page);
    const at = (all: string[], re: RegExp, nth = 0) => all.map((t, i) => (re.test(t) ? i : -1)).filter((i) => i >= 0)[nth] ?? -1;
    let all = await texts();
    const reviews = all.map((t, i) => (/^Review R\d+ finished/.test(t) ? i : -1)).filter((i) => i >= 0);
    expect(reviews).toHaveLength(3);
    // Each round follows the review that sent it, and comes before the next review.
    expect(at(all, /^Fix round 1/)).toBeGreaterThan(reviews[0]);
    expect(at(all, /^Fix round 1/)).toBeLessThan(reviews[1]);
    expect(at(all, /^Fix round 2/)).toBeGreaterThan(reviews[1]);
    expect(at(all, /^Fix round 2/)).toBeLessThan(reviews[2]);

    // The person posts the last review as it is: the line that says so comes after the review run it came of.
    await expandAllNeeds(page);
    await needOfKind(page, "escalation").click();
    const card = needsPane(page).getByRole("group", { name: "Review still blocks" });
    await card.getByRole("button", { name: "Post the review as is" }).click();
    await needsPane(page).getByRole("button", { name: /^Post review/ }).click();
    await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
    await expect.poll(async () => at(await texts(), /^You posted .*GitHub review/)).toBeGreaterThan(-1);
    all = await texts();
    const lastReview = all.map((t, i) => (/^Review R\d+ finished/.test(t) ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(at(all, /^You posted .*GitHub review/)).toBeGreaterThan(lastReview);
  });
});

test.describe("B11: Ctrl+0 goes to Pip home from the Agents screen with a card's button focused", () => {
  test("from a card's own button, and from the card", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await page.getByRole("button", { name: /^Agents/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(pipHome(page)).toBeVisible();

    await page.getByRole("button", { name: /^Agents/ }).click();
    const card = page.locator("main article[data-run-id]").first();
    await card.focus();
    await page.keyboard.press("ControlOrMeta+0");
    await expect(pipHome(page)).toBeVisible();
  });

  test("plain keys on a card's button still stay with the button", async ({ page }) => {
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await page.getByRole("button", { name: /^Agents/ }).click();
    const button = page.locator("main article[data-run-id] button", { hasText: "Draft comment" }).first();
    await button.focus();
    await page.keyboard.press("j");
    await expect(button).toBeFocused();
  });
});

test.describe("B12: the Pip launcher keeps clear of the Agents screen's cards and its Earlier link", () => {
  test("no card and no lane link stands under the launcher, at the top of the list or the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=kinds&prSurface=manual&wsManage=1");
    await page.getByRole("button", { name: /^Agents/ }).click();
    // A run the person stops goes under Earlier, folded, with its "Show" link at the lane's right end.
    await page.locator("main [data-run-id]").filter({ hasText: "WEB-108" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Agent run" });
    await sheet.getByRole("button", { name: "Stop", exact: true }).click();
    await sheet.getByRole("group", { name: "Stop this agent" }).getByRole("button", { name: "Yes, stop" }).dispatchEvent("click");
    await expect(sheet.locator("[data-state]").first()).toHaveAttribute("data-state", "stopped");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    const launcher = page.locator("[data-pip-launcher]");
    await expect(launcher).toBeVisible();
    const show = page.locator('[data-lane="earlier"]').getByRole("button", { name: "Show" });
    await expect(show).toBeVisible();
    const scroller = page.locator("main [data-agents-list]").locator("xpath=..");
    const clear = async (what: string) => {
      const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
      const targets = [show, ...(await page.locator("main article[data-run-id]").all())];
      for (const t of targets) {
        const b = await boxOf(t);
        const over = b.x < l.x + l.width && b.x + b.width > l.x && b.y < l.y + l.height && b.y + b.height > l.y;
        expect(over, `${what}: something stands under the launcher`).toBe(false);
        // Left of its column outright, so no scroll position puts content under it.
        expect(b.x + b.width, `${what}: right edge`).toBeLessThanOrEqual(l.x);
      }
    };
    await clear("top");
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await clear("bottom");
    // The last row also ends above the launcher, with room.
    const last = await boxOf(show);
    const l = await boxOf(launcher.getByRole("button", { name: /^Ask Pip/ }));
    expect(last.y + last.height).toBeLessThanOrEqual(l.y);
  });
});
