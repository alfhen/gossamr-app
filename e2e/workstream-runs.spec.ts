import { expect, test, type Page } from "@playwright/test";
import { PIP_INPUT, advanceRuns, askPip, openApp, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream } from "./support/app";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const peekAgents = (page: Page) => peekSheet(page).locator("#peek-agents");
/** The Agents view's runs; Pip's strip of agents shows runs too, and only the view counts. */
const agentRuns = (page: Page) => page.locator('main [data-run-id]:not(aside[aria-label="Pip"] *)');

/** Dismisses the toasts on screen, which sit over the rail's lower buttons until they time out. */
async function dismissToasts(page: Page) {
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  while ((await dismiss.count()) > 0) await dismiss.first().click();
}

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** What the sample backend's workstreams audit holds, through `__gossamrMock` (exposeMockClock in src/backend/mockWatch.ts). */
const audit = (page: Page) =>
  page.evaluate(() => {
    const mock = (globalThis as { __gossamrMock?: { workstreamEvents(): { action: string; runId: string | null }[] } }).__gossamrMock;
    if (!mock) throw new Error("the sample backend's handle isn't there; is this a dev build in mock mode?");
    return mock.workstreamEvents().map((e) => [e.action, e.runId]);
  });

/** Clicks Start agent in the setup sheet, past the safety sheet a fresh profile shows once at its first agent action. */
async function startFromSetup(page: Page, open: () => Promise<void>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await open();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
    await expect(safety(page)).toHaveCount(0);
  }
  await expect(setup(page)).toContainText("CA-401");
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

/**
 * Starts a workstream on CA-401, asks Pip in its conversation to investigate, opens the run draft Pip made and starts it.
 * Starting it shows the Agents view with the run's sheet.
 */
async function startRunFromPip(page: Page) {
  await startWorkstream(page, "CA-401");
  await askPip(page, "investigate this");
  const draft = pipPane(page).getByRole("article", { name: "Start an agent: CA-401" });
  await expect(draft).toBeVisible();
  await settled(page);
  await startFromSetup(page, () => draft.getByRole("button", { name: "Review and start →" }).click());
  await expect(page.getByText("Agent started on CA-401.", { exact: false })).toBeVisible();
}

/** `startRunFromPip`, then back on the board, where CA-401's peek lists the run as R1 in its workstream. */
async function startInvestigation(page: Page) {
  await startRunFromPip(page);
  await page.getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  await expect(peekAgents(page).locator('[data-run-label="R1"]')).toBeVisible();
}

test("Pip drafts an Investigate run in a workstream; the run and its result draft sit under it as the stage moves", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startInvestigation(page);

  const agents = peekAgents(page);
  const stageChip = agents.locator("[data-workstream] [data-stage]");
  await expect(agents.getByText(/^Workstream: CA-401 /)).toBeVisible();
  await expect(agents.locator('[data-run-label="R1"]')).toHaveText("R1");
  await expect(stageChip).toHaveText("Investigate");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+ · Investigate$/);

  // Queued, launching, working, done.
  await advanceRuns(page, 3);
  await expect(agents.locator("button[data-state=done]")).toBeVisible();
  // A finished investigation leaves the workstream at Investigate; only a finished review or verify is Done.
  await expect(stageChip).toHaveText("Investigate");

  const result = peekSheet(page).locator("#peek-drafts").locator('article:has([data-created-by="agent"])');
  await expect(result.first()).toBeVisible();
  await expect(result.first().locator('[data-created-by="agent"]')).toHaveText("Drafted by an agent");
  // In the workstream's conversation, its drafts are listed: the result draft is there too.
  await expect(pipPane(page).getByRole("region", { name: "Drafts" }).getByRole("article", { name: "Comment on CA-401" })).toBeVisible();

  // A triage started from the ticket's Agent menu joins the workstream as R2 and moves the stage on as it is queued.
  await startFromSetup(page, async () => {
    if (!(await peekSheet(page).isVisible())) await peekTicket(page, "CA-401");
    await peekSheet(page).getByRole("button", { name: "Agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Triage this ticket/ }).click();
  });
  // The Agents view shows it, and the pane stays in the workstream, now at Triage.
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+ · Triage$/);
  await page.getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  await expect(stageChip).toHaveText("Triage");
  await expect(agents.locator('[data-run-label="R2"]')).toBeVisible();
  await advanceRuns(page, 3);
  await expect(agents.locator("button[data-state=done]")).toHaveCount(2);
  // A finished triage is further along than a finished investigation.
  await expect(stageChip).toHaveText("Triage");
});

test("after starting a run from the workstream's conversation, the Agents view keeps that conversation and /stop R1 works there", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startRunFromPip(page);

  // The Agents view, with the new run selected: the pane is still the workstream's, and the run shows R1 and the id to type elsewhere.
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+ · Investigate$/);
  const card = agentRuns(page).first();
  await expect(card).toHaveAttribute("aria-current", "true");
  const ref = (await card.locator("[data-run-ref]").getAttribute("data-run-ref"))!;
  const runId = await card.getAttribute("data-run-id");
  expect(ref.length).toBeGreaterThanOrEqual(4);
  // Grouped by state, the card still carries its short name, as Pip's strip of the workstream's agents does.
  await expect(card.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(pipPane(page).getByRole("region", { name: "Your agents" }).locator('[data-run-label="R1"]')).toBeVisible();
  // Its sheet names it the same two ways, and the pane stays with the workstream while it is open.
  await card.click();
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  await expect(sheet.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(sheet.locator(`[data-run-ref="${ref}"]`)).toBeVisible();
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+ · Investigate$/);

  // Queued, launching, working.
  await advanceRuns(page, 2);
  await expect(page.locator("main [data-run-id][data-state=working]")).toHaveCount(1);
  const input = page.locator(PIP_INPUT);
  const note = pipPane(page).locator("[data-verb-note]");
  await input.fill("/stop R1");
  await input.press("Enter");
  await expect(note).toHaveText("Stopped R1");
  await expect(input).toHaveValue("");
  // A run the person stopped goes under Earlier, folded away; its sheet says so.
  await expect(sheet.locator("[data-state=stopped]").first()).toBeVisible();
  expect(await audit(page)).toContainEqual(["run_stopped", runId]);

  // On the board with nothing peeked and no sheet open, the pane is General: R1 means nothing there, and the refusal names the id on the card.
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(pipConversation(page)).toHaveText("General");
  await input.fill("/retry R1");
  await input.press("Enter");
  await expect(note).toHaveText(`R1 is a workstream's name for a run; here, use its id ${ref}`);
  // What was typed stays, to be put right.
  await expect(input).toHaveValue("/retry R1");
  await input.fill(`/retry ${ref}`);
  await input.press("Enter");
  await expect(note).toHaveText(`Couldn't retry run ${ref}. This run is stopped and has nothing to retry.`);
});

test("Agents groups runs by workstream, with its stage and R1, and the rest under No workstream", async ({ page }) => {
  await openApp(page);
  await startInvestigation(page);
  await page.getByRole("button", { name: /^Agents/ }).click();
  await expect(agentRuns(page).first()).toBeVisible();

  const groupBy = page.getByRole("group", { name: "Group by" });
  await expect(groupBy.getByRole("button", { name: "State" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-lane]").first()).toBeVisible();
  await groupBy.getByRole("button", { name: "Workstream" }).click();

  const groups = page.locator("[data-workstream-group]");
  await expect(groups.first()).toHaveAttribute("data-workstream-group", /^(?!none$)/);
  const mine = groups.first();
  await expect(mine.locator("h3").first()).toHaveText(/^CA-401 /);
  await expect(mine.locator("[data-stage]")).toHaveText("Investigate");
  await expect(mine.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(mine.locator("[data-run-id]")).toHaveCount(1);
  const none = page.locator('[data-workstream-group="none"]');
  await expect(none.locator("h3").first()).toHaveText("No workstream");
  await expect(none.locator("[data-run-id]").first()).toBeVisible();
  await expect(page.locator("[data-lane]")).toHaveCount(0);

  // j and k walk the runs in group order: the workstream's run first, then No workstream's.
  const order = await page.locator("main [data-workstream-group] [data-run-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")));
  await page.locator("main h2", { hasText: "Agents" }).click();
  // Starting the run selected it, and it is first in group order: k stays on it, j goes on to No workstream's newest.
  await expect(page.locator(`main [data-run-id="${order[0]}"]`)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("k");
  await expect(page.locator(`main [data-run-id="${order[0]}"]`)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("j");
  await expect(page.locator(`main [data-run-id="${order[1]}"]`)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("j");
  await expect(page.locator(`main [data-run-id="${order[2]}"]`)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("k");
  await expect(page.locator(`main [data-run-id="${order[1]}"]`)).toHaveAttribute("aria-current", "true");

  // The choice is kept, and State brings the lanes back.
  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Agents/ }).click();
  await expect(page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Workstream" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-workstream-group]").first()).toBeVisible();
  await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "State" }).click();
  await expect(page.locator("[data-lane]").first()).toBeVisible();
  await expect(page.locator("[data-workstream-group]")).toHaveCount(0);
});

test("/stop R1 in the workstream's conversation stops the run without asking Pip; /stop R9 changes nothing", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startInvestigation(page);
  // Queued, launching, working.
  await advanceRuns(page, 2);
  const agents = peekAgents(page);
  await expect(agents.locator("button[data-state=working]")).toBeVisible();

  // The conversation's one turn so far, the question that drafted the run.
  const asked = pipPane(page).getByText("investigate this", { exact: true });
  await expect(asked).toHaveCount(1);

  const input = page.locator(PIP_INPUT);
  await input.fill("/stop R9");
  await input.press("Enter");
  const note = pipPane(page).locator("[data-verb-note]");
  await expect(note).toHaveText("No run R9 in this workstream");
  // A refused command stays in the input, to be put right.
  await expect(input).toHaveValue("/stop R9");
  await expect(agents.locator("button[data-state=working]")).toBeVisible();

  await input.fill("/stop R1");
  await input.press("Enter");
  await expect(note).toHaveText("Stopped R1");
  // Told once, under the input; no toast says it again.
  await expect(page.getByText("Stopped R1", { exact: true })).toHaveCount(1);
  await expect(agents.locator("button[data-state=stopped]")).toBeVisible();
  await expect(input).toHaveValue("");
  expect((await audit(page)).map(([action]) => action)).toContain("run_stopped");
  // Neither command became a turn, and Pip was never asked.
  await expect(asked).toHaveCount(1);
  await expect(pipPane(page).getByText("/stop R1", { exact: true })).toHaveCount(0);

  // The Agents view shows it stopped too.
  await dismissToasts(page);
  await page.getByRole("button", { name: /^Agents/ }).click();
  // A run the person stopped is under Earlier, folded until shown.
  await page.locator('[data-lane="earlier"]').getByRole("button", { name: "Show" }).click();
  await expect(agentRuns(page)).toHaveCount(1);
  await expect(page.locator("main [data-run-id][data-state=stopped]")).toHaveCount(1);
});

test("an unknown /word shows the commands and isn't sent to Pip", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startWorkstream(page, "CA-401");
  const input = page.locator(PIP_INPUT);
  await input.fill("/nudge R1");
  await input.press("Enter");
  await expect(pipPane(page).locator("[data-verb-note]")).toContainText("/nudge isn't a command. Commands are /stop R1, /retry R1 and /answer R1");
  await expect(pipPane(page).getByText("/nudge R1", { exact: true })).toHaveCount(0);
});
