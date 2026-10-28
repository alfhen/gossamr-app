import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, openAgents, openApp, selectWorkstream, paneSettled as settled, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream } from "./support/app";

const peekAgents = (page: Page) => peekSheet(page).locator("#peek-agents");
/** The Agents view's runs; Pip's strip of agents shows runs too, and only the view counts. */
const agentRuns = (page: Page) => page.locator('main [data-run-id]:not(aside[aria-label="Pip"] *)');

/** Starts a workstream on CA-401 and asks Pip in its conversation to investigate, which starts the run. */
async function startRunFromPip(page: Page) {
  await startWorkstream(page, "CA-401");
  await askPip(page, "investigate this");
  await settled(page);
  await expect(pipPane(page).locator('[data-run-label="R1"]').first()).toBeVisible();
}

/** `startRunFromPip`, then back on the board, where CA-401's peek lists the run as R1 in its workstream. */
async function startInvestigation(page: Page) {
  await startRunFromPip(page);
  if (!(await peekSheet(page).isVisible())) {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
  }
  await expect(peekAgents(page).locator('[data-run-label="R1"]')).toBeVisible();
}

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
  await settled(page);
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

test("Work groups runs by workstream, with R1, and the rest under No workstream", async ({ page }) => {
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
