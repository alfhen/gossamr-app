import { expect, type Page, test } from "@playwright/test";
import {
  advanceRuns, agentsHome, allProjects, askPip, expandNeedsYou, expectToast, homeConversation, homeConversationRegion,
  homeSettled, MANUAL_PRS, mockRuns, needRow, needsPane, needsYouCount, openAgents, openApp, openPip, paneSettled,
  peekSheet, peekTicket, pipConversation, pipPane, railButton, runSheet, selectWorkstream, showWorkspace, startAgent,
  startWorkstream,
} from "./support/app";

/** A run's card or row in the Agents view; Pip's strip of agents shows runs too, and only the view counts. */
const agentRun = (page: Page, id: string) => page.locator(`main [data-run-id="${id}"]:not(aside[aria-label="Pip"] *)`).first();

const LIVE = ["launching", "working", "needsAnswer", "needsPermission", "systemBlocked"];

/** How many of the sample backend's runs take a slot. */
const live = async (page: Page) => (await mockRuns(page)).filter((r) => LIVE.includes(r.state)).length;

/** Starts an investigation on `key` as Pip does and returns its run's id, with the Agents view showing. */
async function start(page: Page, key: string): Promise<string> {
  const id = await startAgent(page, key, "investigate");
  await page.getByRole("button", { name: /^Work(,|$)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  if (await sheet.isVisible()) await page.keyboard.press("Escape");
  return id;
}

const peekAgents = (page: Page) => peekSheet(page).locator("#peek-agents");

/** The Agents view's runs; Pip's strip of agents shows runs too, and only the view counts. */
const agentRuns = (page: Page) => page.locator('main [data-run-id]:not(aside[aria-label="Pip"] *)');

/** Starts a workstream on CA-401 and asks Pip in its conversation to investigate, which starts the run. */
async function startRunFromPip(page: Page) {
  await startWorkstream(page, "CA-401");
  await askPip(page, "investigate this");
  await paneSettled(page);
  await expect(pipPane(page).locator('[data-run-label="R1"]').first()).toBeVisible();
}

/** `startRunFromPip`, then back on the board, where CA-401's peek lists the run as R1 in its workstream. */
async function startInvestigation(page: Page) {
  await startRunFromPip(page);
  if (!(await peekSheet(page).isVisible())) {
    await allProjects(page);
    await peekTicket(page, "CA-401");
  }
  await expect(peekAgents(page).locator('[data-run-label="R1"]')).toBeVisible();
}

test("a launch --bg refused for the permission mode offers Terminal to accept it, and Retry waits for that", async ({ page }) => {
  await openApp(page, "runs=failures");
  await openAgents(page);
  await expandNeedsYou(page);
  await needRow(page, /WEB-122/).click();
  const retry = needsPane(page).getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeDisabled();
  await needsPane(page).getByRole("button", { name: "Open Terminal to accept auto mode" }).click();
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(needRow(page, /WEB-122/)).toHaveCount(0);
});

test("Ask Pip on a ticket starts an investigation agent, which shows on the Work screen", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
  await askPip(page, "investigate this");
  await homeSettled(page);

  const timeline = homeConversationRegion(page).locator("[data-timeline-entry]");
  await expect(timeline.filter({ hasText: /Investigator R1/ })).toHaveCount(1);
  const run = (await mockRuns(page)).find((r) => r.step === "investigate" && r.key === "CA-401");
  expect(run).toBeTruthy();
  await expect(page.locator(`main article[data-run-id="${run!.id}"]`).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Start an agent" })).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText("0");
});

test("when Pip stops an agent the conversation says so", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await askPip(page, "investigate this");
  await homeSettled(page);
  await askPip(page, "stop R1");
  await homeSettled(page);

  await expect.poll(async () => (await mockRuns(page)).find((r) => r.step === "investigate")?.state).toBe("stopped");
  await expect(homeConversationRegion(page).locator("[data-timeline-entry]").filter({ hasText: "Pip stopped R1" })).toHaveCount(1);
});

test.describe("a run's sheet", () => {
  test("stopping a run from a sheet scrolled down brings its title and the Stopped pill back into view", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Work(,|$)/ }).click();
    await page.locator('[data-run-id]').filter({ hasText: "WEB-108" }).first().click();
    await expect(runSheet(page)).toBeVisible();
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "working");
    await runSheet(page).getByRole("button", { name: "Stop", exact: true }).click();
    const confirm = runSheet(page).getByRole("group", { name: "Stop this agent" });
    await expect(confirm).toBeVisible();
    // The confirm row stays on one line.
    const box = await confirm.boundingBox();
    const yes = await confirm.getByRole("button", { name: "Yes, stop" }).boundingBox();
    expect(box && yes && box.height).toBeLessThan((yes?.height ?? 0) * 1.6);
    const body = runSheet(page).locator("[data-sheet-body]");
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await confirm.getByRole("button", { name: "Yes, stop" }).dispatchEvent("click");
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "stopped");
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(runSheet(page).getByRole("heading", { level: 2 })).toBeInViewport();
    await expect(runSheet(page).locator('span[data-state="stopped"]').first()).toBeInViewport();
  });
});

test.describe("the Your agents strip", () => {
  test("Your agents says how many of all it shows, links to the rest, and lists the failed run the tray lists", async ({ page }) => {
    await openApp(page);
    await openPip(page);
    const strip = pipPane(page).getByRole("region", { name: "Your agents" });
    // Out of the runs it lists, the live ones and those waiting on the person, not the finished ones too.
    const listed = new Set(["needsAnswer", "needsPermission", "systemBlocked", "failed", "queued", "launching", "working"]);
    const total = (await mockRuns(page)).filter((r) => listed.has(r.state)).length;
    expect(total).toBeGreaterThan(3);
    expect(total).toBeLessThan((await mockRuns(page)).length);
    await expect(strip.locator("[data-strip-count]")).toHaveText(`3 of ${total}`);
    await expect(strip.locator("article[data-run-id]")).toHaveCount(3);
    await expect(strip.locator('article[data-state="failed"]')).toContainText("SUP-9");
    await strip.getByRole("button", { name: "See all in Agents" }).click();
    await expect(page.locator("[data-workstream-group]").first()).toBeVisible();
  });
});

test.describe("a queued run", () => {
  test("can be cancelled from its sheet before it launches, with its own confirmation", async ({ page }) => {
    await page.goto("/?runs=empty&mockRepos=14");
    await page.getByRole("button", { name: "Start watching" }).click();
    await showWorkspace(page);
    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await startAgent(page, "CA-401", "investigate");
    await expect.poll(async () => (await mockRuns(page)).map((r) => r.state)).toEqual(["queued"]);
    const [queued] = await mockRuns(page);
    await railButton(page, /^Work/).click();
    await page.locator(`main article[data-run-id="${queued.id}"]`).click();
    await expect(runSheet(page)).toBeVisible();
    await runSheet(page).getByRole("button", { name: "Cancel", exact: true }).click();
    const ask = runSheet(page).getByRole("group", { name: "Cancel this run" });
    await expect(ask).toContainText("Cancel this run? It hasn't started, so nothing is lost.");
    await ask.getByRole("button", { name: "Yes, cancel" }).click();
    await expect.poll(async () => (await mockRuns(page)).map((r) => r.state)).toEqual(["stopped"]);
    await expect(runSheet(page).locator("[data-state]").first()).toHaveAttribute("data-state", "stopped");
  });
});

test.describe("a free role", () => {
  test("shows on the run's card and sheet as the role Pip gave it", async ({ page }) => {
    await page.goto("/?runs=empty&mockRepos=14");
    await page.getByRole("button", { name: "Start watching" }).click();
    await showWorkspace(page);
    await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
    await startAgent(page, "CA-401", "code auditor");
    await expect.poll(async () => (await mockRuns(page)).map((r) => r.role)).toEqual(["code auditor"]);
    const [run] = await mockRuns(page);
    await railButton(page, /^Work/).click();
    const card = page.locator(`main article[data-run-id="${run.id}"]`);
    await expect(card).toContainText("Code auditor");
    await card.click();
    await expect(runSheet(page)).toContainText("Code auditor");
    await expect(runSheet(page)).toContainText("Role: code auditor.");
  });
});

test.describe("agent rows on Work", () => {
  test("has an agent row with its state and role, Open in Terminal and Stop, and opens the report from it", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const work = agentsHome(page);
    const row = work.locator('article[data-state="working"]').first();
    await expect(row).toBeVisible();
    await expect(row.locator("[data-role]")).toBeVisible();
    await expect(row.locator("span[data-state]").first()).toBeVisible();
    await expect(row.getByRole("button", { name: "Open in Terminal" })).toHaveCount(1);
    const done = work.locator('article[data-state="done"]').first();
    await expect(done.getByRole("button", { name: "Open in Terminal" })).toHaveCount(1);
    await done.click();
    await expect(page.locator("#agent-sheet [data-run-report]")).toBeVisible();
  });

  test("stops an agent from its row after one question", async ({ page }) => {
    await openApp(page);
    await openAgents(page);
    const row = agentsHome(page).locator('article[data-state="working"]').first();
    const id = await row.getAttribute("data-run-id");
    await row.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(row.getByRole("group", { name: "Stop this agent" })).toBeVisible();
    await row.getByRole("button", { name: "Yes, stop" }).click();
    await expect(agentsHome(page).locator(`article[data-run-id="${id}"]`)).toHaveAttribute("data-state", "stopped");
  });
});

test("with three agents running a 4th approved run waits for a slot, never over the cap, and launches when one finishes", async ({ page }) => {
  // A signed-in GitHub connection, so there are repositories to run in (`?mockRepos`, src/backend/mockWatch.ts).
  await page.goto("/?runs=empty&runsCap=3&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  const running: string[] = [];
  for (const key of ["CA-401", "CA-402", "CA-403"]) {
    running.push(await start(page, key));
  }
  for (const id of running) await advanceRuns(page, 2, id);
  expect((await mockRuns(page)).filter((r) => running.includes(r.id)).map((r) => r.state)).toEqual(["working", "working", "working"]);

  // The 4th waits for a slot.
  const fourth = await start(page, "CA-404");
  await expect(agentRun(page, fourth)).toContainText("Waiting for a slot · 1st in line");
  expect((await mockRuns(page)).find((r) => r.id === fourth)?.state).toBe("queued");

  // Stepping it along leaves it waiting, and the cap holds.
  for (let i = 0; i < 2; i++) {
    await advanceRuns(page, 1, fourth);
    expect((await mockRuns(page)).find((r) => r.id === fourth)?.state).toBe("queued");
    expect(await live(page)).toBe(3);
  }
  await expect(agentRun(page, fourth)).toContainText("Waiting for a slot · 1st in line");

  // One finishes, and the waiting one launches by itself.
  await advanceRuns(page, 1, running[0]);
  expect((await mockRuns(page)).find((r) => r.id === running[0])?.state).toBe("done");
  expect((await mockRuns(page)).find((r) => r.id === fourth)?.state).toBe("launching");
  expect(await live(page)).toBe(3);
  await expect(agentRun(page, fourth)).not.toContainText("Waiting for a slot");
  await expect(agentRun(page, fourth)).toHaveAttribute("data-state", "launching");
  await advanceRuns(page, 1, fourth);
  await expect(agentRun(page, fourth)).toHaveAttribute("data-state", "working");
  expect(await live(page)).toBe(3);
});

test("a run waiting for a slot can be stopped from its sheet, and Stop all stops the waiting ones too and launches nothing", async ({ page }) => {
  await page.goto("/?runs=empty&runsCap=3&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  const running: string[] = [];
  for (const key of ["CA-401", "CA-402", "CA-403"]) {
    running.push(await start(page, key));
  }
  for (const id of running) await advanceRuns(page, 2, id);
  const waiting: string[] = [];
  for (const key of ["CA-404", "CA-405"]) {
    waiting.push(await start(page, key));
  }
  // Each says it waits for a slot, apart from the running ones.
  for (const id of waiting) await expect(agentRun(page, id)).toContainText("Waiting for a slot");

  // From its sheet the second in line says it starts on its own, offers no Start now, and can be stopped.
  await agentRun(page, waiting[1]).click();
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  await expect(sheet).toContainText("It is approved and starts on its own when one of the running agents finishes (2nd in line). Stop it if you no longer want it.");
  await expect(sheet.getByRole("button", { name: "Start now" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Stop", exact: true }).click();
  await sheet.getByRole("button", { name: "Yes, stop" }).click();
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === waiting[1])?.state).toBe("stopped");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Stop all names the one still waiting, stops it with the rest, and nothing takes the freed slots.
  await page.getByRole("button", { name: "Stop all", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Stop all agents" });
  await expect(confirm).toContainText("Stop 3 agents and 1 waiting to start?");
  await confirm.getByRole("button", { name: "Yes, stop all" }).click();
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === waiting[0])?.state).toBe("stopped");
  expect((await mockRuns(page)).filter((r) => [...running, ...waiting].includes(r.id)).map((r) => r.state)).toEqual(["stopped", "stopped", "stopped", "stopped", "stopped"]);
  await advanceRuns(page, 2);
  expect(await live(page)).toBe(0);
  // Toasts show one at a time and each stays for seconds, so this one queues behind the earlier ones; expectToast clears those.
  await expectToast(page, "Stopped 3 agents and 1 waiting to start");
});

test("Pip starts an Investigate run in a workstream; the run and its result draft sit under it as the stage moves", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startInvestigation(page);

  const agents = peekAgents(page);
  const status = agents.locator("[data-workstream] [data-header-status] [data-status]");
  await expect(agents.getByText(/^Workstream: CA-401 /)).toBeVisible();
  await expect(agents.locator('[data-run-label="R1"]')).toHaveText("R1");
  await expect(status).toHaveText("Running");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);

  // Queued, launching, working, done.
  await advanceRuns(page, 3);
  await expect(agents.locator("button[data-state=done]")).toBeVisible();
  // The finished investigation left a draft, which waits on the person; only a finished review or verify is Done.
  await expect(status).toHaveText("Needs you");

  const result = peekSheet(page).locator("#peek-drafts").locator('article:has([data-created-by="agent"])');
  await expect(result.first()).toBeVisible();
  await expect(result.first().locator('[data-created-by="agent"]')).toHaveText("Drafted by an agent");
  // In the workstream's conversation, its timeline, its drafts are listed: the result draft is there too.
  await expect(pipPane(page).locator('[data-timeline] [data-timeline-entry][data-kind="draft"]').getByRole("article", { name: "Comment on CA-401" })).toBeVisible();

  // A triage Pip starts joins the workstream as R2 and moves the stage on as it is queued.
  await askPip(page, "triage this");
  await paneSettled(page);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
  if (!(await peekSheet(page).isVisible())) await peekTicket(page, "CA-401");
  await expect(status).toHaveText("Needs you");
  await expect(agents.locator('[data-run-label="R2"]')).toBeVisible();
  await advanceRuns(page, 3);
  await expect(agents.locator("button[data-state=done]")).toHaveCount(2);
  await expect(status).toHaveText("Needs you");
});

test("after Pip starts a run in the workstream's conversation, the Agents view keeps that conversation and names the run R1", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startRunFromPip(page);
  await openAgents(page);
  await selectWorkstream(page, "CA-401");

  // The pane is still the workstream's, and the run shows R1 and the id to type elsewhere.
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
  const card = agentRuns(page).first();
  const ref = (await card.locator("[data-run-ref]").getAttribute("data-run-ref"))!;
  const runId = await card.getAttribute("data-run-id");
  expect(ref.length).toBeGreaterThanOrEqual(4);
  // Grouped by state, the card still carries its short name, as the run's card on the workstream's timeline in Pip does.
  await expect(card.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(pipPane(page).locator(`[data-timeline] [data-timeline-entry="run:${runId}"] article[data-run-id="${runId}"]`).locator('[data-run-label="R1"]')).toBeVisible();
  // Its sheet names it the same two ways, and the pane stays with the workstream while it is open.
  await card.click();
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  await expect(sheet.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(sheet.locator(`[data-run-ref="${ref}"]`)).toBeVisible();
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
});

test("Work groups runs by workstream, and the rest under No workstream", async ({ page }) => {
  await openApp(page);
  await startInvestigation(page);
  await page.getByRole("button", { name: /^Work(,|$)/ }).click();
  await expect(agentRuns(page).first()).toBeVisible();

  const groups = page.locator("[data-workstream-group]");
  await expect(groups.first()).toHaveAttribute("data-workstream-group", /^(?!none$)/);
  const mine = groups.first();
  await expect(mine.locator("h3").first()).toHaveText(/^CA-401/);
  await expect(mine.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(mine.locator("[data-run-id]")).toHaveCount(1);
  const none = page.locator('[data-workstream-group="none"]');
  await expect(none.locator("h3").first()).toHaveText("No workstream");
  await expect(none.locator("[data-run-id]").first()).toBeVisible();
});
