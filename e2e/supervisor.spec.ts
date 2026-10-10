import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  askPip,
  heldBanner,
  holdAll,
  holdPip,
  jiraWrites,
  mockRuns,
  openApp,
  peekSheet,
  peekTicket,
  pipConversation,
  pipPane,
  scriptNextRun,
  setBudget,
  setManage,
  startWorkstream,
  surfacePullRequests,
  wakeTurns,
  wakes,
  workstreamEvents,
} from "./support/app";

// A workstream in Manage mode (`wsManage=1` opens new ones so): the sample supervisor wakes Pip once for each finished
// run and starts the routine next steps by the fixed rules, with no click. Pull requests show only when a test says.
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

/**
 * Moves run `id` on to done: queued, launching, working, done. Only that run moves. It waits for Pip to finish
 * answering first, so each finish gets a wake turn of its own rather than merging into one still waiting.
 */
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
  await page.getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

/** Investigation, triage and plan, with the plan approved: returns the build the rules started. */
async function toBuild(page: Page) {
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await finish(page, r1.id);
  await finish(page, (await started(page, "triage")).id);
  await finish(page, (await started(page, "plan")).id);
  await approvePlan(page);
  return started(page, "build");
}

/** Back to every project's tickets, from the rail, so any ticket can be peeked. */
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

const actions = async (page: Page, action: string) => (await workstreamEvents(page)).filter((e) => e.action === action);

test("a finished investigation wakes Pip once and starts the triage on its own; asked again, nothing doubles", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await expect(wakes(page)).toHaveCount(0);

  await finish(page, r1.id);
  await expect(wakes(page)).toHaveCount(1);
  await expect(wakes(page).locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  await expect(wakes(page)).toContainText("Triage R2 is queued to start automatically.");
  const triage = await started(page, "triage");
  await expect(pipPane(page).locator(`article[data-run-id="${triage.id}"]`)).toContainText("Queued automatically after R1");

  // The same finish again, and a look over everything, wake nobody.
  await advanceRuns(page, 1, r1.id);
  await surfacePullRequests(page);
  await settled(page);
  await expect(wakes(page)).toHaveCount(1);
  expect((await actions(page, "wake")).map((e) => e.runId)).toEqual([r1.id]);
  expect((await actions(page, "autostart")).map((e) => e.detail)).toEqual([`investigate_triage after ${r1.id}`]);

  // Pip's own turns start and stop nothing.
  const before = await mockRuns(page);
  await askPip(page, "start the build");
  await settled(page);
  await askPip(page, "stop R2");
  await settled(page);
  expect(await mockRuns(page)).toEqual(before);
  expect(await jiraWrites(page)).toEqual([]);
});

test("a triage that recommends a plan starts one; one that doesn't starts nothing and Pip says so", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  const triage = await started(page, "triage");
  await finish(page, triage.id);
  const plan = await started(page, "plan");
  expect(plan).toMatchObject({ state: "queued" });
  await expect(wakes(page)).toHaveCount(2);
  await expect(wakes(page).last()).toContainText("Plan R3 is queued to start automatically.");

  // A second investigation's triage, scripted to say no plan is needed, starts nothing.
  await scriptNextRun(page, "triage", { planRecommended: false });
  await finish(page, plan.id);
  await startInvestigation(page);
  const again = (await newest(page, "investigate"))!;
  await finish(page, again.id);
  const second = await started(page, "triage", triage.id);
  await finish(page, second.id);
  await expect(wakes(page).last()).toContainText("doesn't recommend a plan, so nothing starts on its own");
  expect((await newest(page, "plan"))?.id).toBe(plan.id);
});

test("the plan waits for the person's approval, which is the only Jira write and starts the build; its review waits for the pull request, blocks, gets a fix round and then passes", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  const ws = (await workstreamEvents(page))[0].workstreamId;
  // Eight finishes with no message from the person: more than the six automatic turns a workstream has by default.
  await setBudget(page, ws, { autoTurns: 12 });
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await finish(page, (await started(page, "triage")).id);
  const plan = await started(page, "plan");
  await finish(page, plan.id);
  expect(await newest(page, "build")).toBeNull();
  expect(await jiraWrites(page)).toEqual([]);

  await approvePlan(page);
  const writes = await jiraWrites(page);
  expect(writes.map((w) => [w.type, w.key])).toEqual([["rewrite", "CA-401"]]);
  const build = await started(page, "build");

  await finish(page, build.id);
  await expect.poll(async () => (await actions(page, "waiting_for_pr")).length).toBe(1);
  expect(await newest(page, "review")).toBeNull();
  await surfacePullRequests(page);
  const review = await started(page, "review");
  await expect(pipPane(page).locator(`article[data-run-id="${review.id}"]`)).toContainText("Queued automatically after R4");

  // The default review blocks: fix round 1 sends the build back with its findings.
  await finish(page, review.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("working");
  expect(await actions(page, "fix_round_sent")).toHaveLength(1);
  await expect(wakes(page).last()).toContainText("fix round 1 went to build R4");
  await finish(page, build.id);
  expect((await newest(page, "review"))?.id).toBe(review.id);
  await surfacePullRequests(page);
  const second = await started(page, "review", review.id);
  await scriptNextRun(page, "review", { verdict: "pass" });
  await finish(page, second.id);
  await expect(wakes(page).last()).toContainText("passed");

  // Verify is off by default, so the chain ends here; Pip was woken once for each finish.
  await settled(page);
  expect(await newest(page, "verify")).toBeNull();
  const woken = await actions(page, "wake");
  expect(woken).toHaveLength(7);
  await expect(wakes(page)).toHaveCount(7);
  expect(await jiraWrites(page)).toEqual(writes);
});

test("after two fix rounds a review that still blocks starts nothing and comes to the person", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  const ws = (await workstreamEvents(page))[0].workstreamId;
  await setBudget(page, ws, { autoTurns: 12 });
  const build = await toBuild(page);
  let review: string | null = null;
  for (let round = 0; round < 3; round++) {
    await finish(page, build.id);
    await surfacePullRequests(page);
    review = (await started(page, "review", review)).id;
    await finish(page, review);
  }
  await expect.poll(async () => (await actions(page, "fix_rounds_exhausted")).map((e) => e.runId)).toEqual([review]);
  expect(await actions(page, "fix_round_sent")).toHaveLength(2);
  expect((await mockRuns(page)).find((r) => r.id === build.id)?.state).toBe("done");
  await expect(wakes(page).last()).toContainText("The review still blocks after 2 fix rounds. Over to you.");
  expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["rewrite"]);
});

test("a used-up budget holds the workstream, so nothing in it launches or wakes Pip until the person writes", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  const ws = (await workstreamEvents(page))[0].workstreamId;
  await setBudget(page, ws, { autoTurns: 2 });
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  const triage = await started(page, "triage");
  await finish(page, triage.id);
  await expect(wakes(page)).toHaveCount(2);
  await expect.poll(async () => (await actions(page, "held")).map((e) => e.detail)).toEqual(["budget"]);
  await expect(heldBanner(page)).toHaveText(/^Budget used up\. Say carry on to continue/);

  // The second wake used the budget up. The plan it reports had started already, but held, it never launches.
  const plan = await started(page, "plan");
  await settled(page);
  await advanceRuns(page, 3, plan.id);
  expect((await mockRuns(page)).find((r) => r.id === plan.id)?.state).toBe("queued");

  // Only the person's message counts the turns from zero again and lifts the hold: the plan goes on and its finish wakes Pip.
  await askPip(page, "carry on");
  await settled(page);
  expect((await actions(page, "resumed")).map((e) => [e.actor, e.detail])).toEqual([["person", "budget"]]);
  await expect(heldBanner(page)).toHaveCount(0);
  await finish(page, plan.id);
  await expect(wakes(page)).toHaveCount(3);
  expect((await actions(page, "wake")).map((e) => e.runId)).toContain(plan.id);
});

test("a child's answer holding a data marker holds the workstream and drops it to Advise, starting nothing", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await scriptNextRun(page, "investigate", { marker: true });
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await expect.poll(async () => (await workstreamEvents(page)).filter((e) => e.actor === "supervisor").map((e) => [e.action, e.detail])).toEqual([
    ["tripwire", "marker"],
    ["mode_set", "advise"],
    ["held", "tripwire:marker"],
  ]);
  expect(await newest(page, "triage")).toBeNull();
  await expect(wakes(page)).toHaveCount(0);
  expect(await jiraWrites(page)).toEqual([]);
});

test("the budget warns in amber before it runs out, then holds with what to say", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  const ws = (await workstreamEvents(page))[0].workstreamId;
  await setBudget(page, ws, { wakes: 5 });
  const amber = pipPane(page).locator('[data-budget="amber"]');
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  const triage = await started(page, "triage");
  await finish(page, triage.id);
  await finish(page, (await started(page, "plan")).id);
  await expect(wakes(page)).toHaveCount(3);
  await expect(amber).toHaveCount(0);

  // The person's message counts the automatic turns from zero, never the wakes: the fourth is 80% of five. Pip
  // finishes the last wake first, or the message would set it aside and ask it again behind itself.
  await settled(page);
  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  await expect(wakes(page)).toHaveCount(4);
  await expect(amber).toHaveText("4 of 5 wakes used");
  await expect(heldBanner(page)).toHaveCount(0);

  await finish(page, (await started(page, "triage", triage.id)).id);
  await expect(wakes(page)).toHaveCount(5);
  await expect(heldBanner(page)).toHaveText(/^Budget used up\. Say carry on to continue/);
  await expect(amber).toHaveCount(0);
  await expect(pipPane(page).getByRole("button", { name: "Resume" })).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);
});

test("Esc closes only the popover or menu that is open: the pane, the peek and the workstream's conversation stay", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  const trigger = pipPane(page).getByRole("button", { name: "Automatic steps" });
  const more = pipPane(page).getByRole("button", { name: "More for this workstream" });
  const stays = async () => {
    await expect(pipPane(page)).toHaveCount(1);
    await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  };

  // With the ticket's peek open.
  await trigger.click();
  await expect(pipPane(page).getByRole("dialog", { name: "Automatic steps" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pipPane(page).getByRole("dialog", { name: "Automatic steps" })).toHaveCount(0);
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await stays();
  await expect(trigger).toBeFocused();

  await more.click();
  const stop = pipPane(page).getByRole("menuitem", { name: "Stop the workstream…" });
  await expect(stop).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(stop).toHaveCount(0);
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await stays();
  await expect(more).toBeFocused();

  // The Stop confirmation closes on Esc too, and hands focus back to the menu's button.
  await more.click();
  await stop.click();
  await expect(pipPane(page).getByRole("group", { name: "Stop this workstream" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pipPane(page).getByRole("group", { name: "Stop this workstream" })).toHaveCount(0);
  await stays();
  await expect(more).toBeFocused();

  // With no peek, where Esc would otherwise close the pane.
  await startInvestigation(page);
  await expect(peekSheet(page)).toHaveCount(0);
  await stays();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(pipPane(page).getByRole("dialog", { name: "Automatic steps" })).toHaveCount(0);
  await stays();
  await expect(trigger).toBeFocused();
});

test("Manage is the person's switch; a rule turned off for the workstream, or in Settings, starts nothing", async ({ page }) => {
  await openApp(page, "runs=empty&prSurface=manual");
  await startWorkstream(page, "CA-401");
  await expect(pipPane(page).getByRole("button", { name: "Hold all workstreams" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hold all workstreams" })).toHaveCount(0);
  await setManage(page);
  await expect(page.getByRole("button", { name: "Hold all workstreams" })).toBeVisible();

  // Triage → Plan off for this workstream only, in its Automatic steps.
  await pipPane(page).getByRole("button", { name: "Automatic steps" }).click();
  const steps = pipPane(page).getByRole("dialog", { name: "Automatic steps" });
  await expect(steps.getByRole("radiogroup", { name: "Investigate → Triage" }).getByRole("radio", { name: "As in Settings (on)" })).toHaveAttribute("aria-checked", "true");
  await steps.getByRole("radiogroup", { name: "Triage → Plan" }).getByRole("radio", { name: "Off" }).click();
  await expect(steps.locator('[data-rule="triage_plan"]')).toHaveAttribute("data-choice", "off");
  await page.keyboard.press("Escape");
  await expect(steps).toHaveCount(0);
  expect((await workstreamEvents(page)).filter((e) => e.actor === "person").map((e) => [e.action, e.detail])).toEqual([
    ["opened", null],
    ["mode_set", "manage"],
    ["rule_set", "triage_plan=off"],
  ]);

  await startInvestigation(page);
  await finish(page, (await newest(page, "investigate"))!.id);
  const triage = await started(page, "triage");
  await finish(page, triage.id);
  await expect(wakes(page)).toHaveCount(2);
  await settled(page);
  expect(await newest(page, "plan")).toBeNull();
  expect((await actions(page, "autostart")).map((e) => e.detail?.split(" ")[0])).toEqual(["investigate_triage"]);

  // Investigate → Triage off in Settings: a new workstream's finished investigation starts nothing.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("agent safety");
  await page.keyboard.press("Enter");
  const sheet = safety(page);
  await expect(sheet).toBeVisible();
  const global = sheet.getByRole("switch", { name: "Investigate → Triage" });
  await expect(global).toHaveAttribute("aria-checked", "true");
  await expect(sheet.getByRole("switch", { name: "Passing review → Verify" })).toHaveAttribute("aria-checked", "false");
  await global.click();
  await expect(global).toHaveAttribute("aria-checked", "false");
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "All projects" }).click();

  await startWorkstream(page, "CA-402");
  await setManage(page);
  await startInvestigation(page, "CA-402");
  const second = (await newest(page, "investigate"))!;
  await finish(page, second.id);
  await expect(wakes(page)).toHaveCount(1);
  await settled(page);
  expect((await newest(page, "triage"))?.id).toBe(triage.id);
  expect((await actions(page, "wake")).map((e) => e.runId)).toContain(second.id);
  expect(await jiraWrites(page)).toEqual([]);
});

test("Hold all, from the rail or with its shortcut, stops a running wake and every automatic step; Resume wakes Pip once for what finished meanwhile", async ({ page }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await allProjects(page);
  await startWorkstream(page, "CA-402");
  await startInvestigation(page, "CA-402");
  const r2 = (await newest(page, "investigate"))!;
  expect(r2.id).not.toBe(r1.id);
  await advanceRuns(page, 2, r2.id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === r2.id)?.state).toBe("working");

  // CA-401's investigation finishes and wakes Pip, who is held answering.
  await allProjects(page);
  await peekTicket(page, "CA-401");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await holdPip(page, true);
  await finish(page, r1.id);
  await expect(wakes(page)).toHaveCount(1);
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toBeVisible();
  const triage = await started(page, "triage");

  await holdAll(page, "button");
  await expect(page.getByText(/^Held 2 workstreams\./)).toBeVisible();
  await expect(wakes(page)).toContainText("Set aside");
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  await holdPip(page, false);
  await expect(heldBanner(page)).toHaveText(/^Held: Hold all/);
  expect((await actions(page, "held")).map((e) => e.detail)).toEqual(["hold_all", "hold_all"]);

  // Its agents carry on: CA-402's investigation finishes, but nobody is woken and nothing starts; the queued triage waits.
  await finish(page, r2.id);
  await advanceRuns(page, 3);
  expect((await mockRuns(page)).find((r) => r.id === triage.id)?.state).toBe("queued");
  expect((await newest(page, "triage"))?.id).toBe(triage.id);
  expect((await actions(page, "wake")).map((e) => e.runId)).toEqual([r1.id]);
  expect(await wakeTurns(page)).toBe(1);

  // Resuming CA-402 wakes Pip once, for its finished investigation only; Pip is held answering again.
  await allProjects(page);
  await peekTicket(page, "CA-402");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-402 /);
  await expect(wakes(page)).toHaveCount(0);
  await holdPip(page, true);
  await heldBanner(page).getByRole("button", { name: "Resume" }).click();
  await expect(heldBanner(page)).toHaveCount(0);
  await expect(wakes(page)).toHaveCount(1);
  await expect(wakes(page).locator("[data-wake-header]")).toHaveText(/^Pip picked this up: run R1 finished$/);
  expect((await actions(page, "wake")).map((e) => e.runId).sort()).toEqual([r1.id, r2.id].sort());

  // The shortcut does the same while that wake runs.
  await holdAll(page, "shortcut");
  await expect(heldBanner(page)).toHaveText(/^Held: Hold all/);
  await expect(wakes(page)).toContainText("Set aside");
  await holdPip(page, false);
  await settled(page);
  expect(await wakeTurns(page)).toBe(1);
  expect((await actions(page, "wake")).map((e) => e.runId).sort()).toEqual([r1.id, r2.id].sort());
  expect(await jiraWrites(page)).toEqual([]);
});

// The sample's runs don't outlive the tab, so Resume here has no finished run to wake Pip for; that each finished run
// wakes Pip at most once across a restart is checked in Rust (after_a_restart_resuming_wakes_pip_once_per_run_it_was_not_woken_for).
test("after a restart every open workstream is held with no new wake, and Resume lifts the hold and wakes nothing again", async ({ page, context }) => {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await startInvestigation(page);
  const r1 = (await newest(page, "investigate"))!;
  await finish(page, r1.id);
  await expect(wakes(page)).toHaveCount(1);
  await settled(page);

  await page.close();
  const again = await context.newPage();
  await openApp(again, MANAGED);
  await peekTicket(again, "CA-401");
  await peekSheet(again).getByRole("button", { name: "Open in Pip" }).click();
  await expect(pipConversation(again)).toHaveText(/^Workstream: CA-401 /);
  await expect(heldBanner(again)).toHaveText(/^Held after a restart/);
  await expect(wakes(again)).toHaveCount(1);
  const held = (await workstreamEvents(again)).filter((e) => e.action === "held" || e.action === "wake");
  expect(held.map((e) => [e.actor, e.action, e.detail ?? null])).toEqual([
    ["supervisor", "wake", expect.stringMatching(/^done/)],
    ["supervisor", "held", "restart"],
  ]);

  await heldBanner(again).getByRole("button", { name: "Resume" }).click();
  await expect(heldBanner(again)).toHaveCount(0);
  await settled(again);
  expect(await wakeTurns(again)).toBe(1);
  expect((await workstreamEvents(again)).filter((e) => e.action === "wake").map((e) => e.runId)).toEqual([r1.id]);
  expect((await workstreamEvents(again)).filter((e) => e.action === "resumed").map((e) => [e.actor, e.detail])).toEqual([["person", "restart"]]);
  expect(await jiraWrites(again)).toEqual([]);
});
