import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  expandNeedsYou,
  heldBanner,
  holdAll,
  holdBySystem,
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
  setBudget,
  startWorkstream,
  surfacePullRequests,
  wakes,
  workstreamEvents,
  workstreamRow,
} from "./support/app";

// Two product decisions (docs/needs-you.md): a hold the person chose is not a need, and the automatic budget is one unit,
// "automatic steps", whose running out is a Decide question in Needs you with "Allow 5 more" and "Switch to Advise".

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
async function startInvestigation(page: Page) {
  await settled(page);
  await askPip(page, "investigate this");
  await settled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await runCards(page, "CA-401").last().getByRole("button", { name: "Review and start →" }).click();
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
