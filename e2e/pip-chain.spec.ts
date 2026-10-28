import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, detailsOf, openApp, paneSettled as settled, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream, stepOf, surfacePullRequests } from "./support/app";

// The rest of the refusal of a review whose build's pull request isn't found yet, as WAITING_FOR_PR_HINT in src-tauri/src/inbox/workstreams.rs.
const NO_PR_YET = "that build has no pull request yet. Gossamr asked GitHub for it";

const runSheet = (page: Page) => page.getByRole("dialog", { name: "Agent run" });
const runCard = (page: Page, id: string) => pipPane(page).locator(`article[data-run-id="${id}"]`);

/** Asks Pip for `what` and waits for its answer. */
async function ask(page: Page, what: string) {
  await askPip(page, what);
  await expect(pipPane(page).getByText(what, { exact: true }).last()).toBeVisible();
  await settled(page);
}

/** Asks Pip for `what`, which starts an agent of `kind`; returns its run's id. */
async function start(page: Page, what: string, kind: string) {
  const before = new Set((await runIds(page)).map((r) => r.id));
  await ask(page, what);
  await expect.poll(async () => (await runIds(page)).filter((r) => stepOf(r.role) === kind && !before.has(r.id)).length).toBe(1);
  return (await runIds(page)).find((r) => stepOf(r.role) === kind && !before.has(r.id))!.id;
}

/** Opens run `id`'s sheet from its card in the pane, and what the agent was told, which it shows read-only. */
async function told(page: Page, id: string) {
  await runCard(page, id).getByRole("button", { name: /^Open / }).click();
  await expect(runSheet(page)).toBeVisible();
  const details = detailsOf(runSheet(page), "What the agent was told");
  await details.locator("> summary").first().click();
  return details;
}

async function closeSheet(page: Page) {
  await runSheet(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(runSheet(page)).toHaveCount(0);
}

/** The runs the sample backend holds, through `__gossamrMock` (exposeMockClock in src/backend/mockWatch.ts). */
const runIds = (page: Page) =>
  page.evaluate(() => {
    const mock = (globalThis as { __gossamrMock?: { runs(): { id: string; role: string }[] } }).__gossamrMock;
    return mock ? mock.runs().map((r) => ({ id: r.id, role: r.role })) : [];
  });
const runCount = async (page: Page) => (await runIds(page)).length;

/** The Agents view's cards; Pip's strip of agents shows runs too, and only the view counts. */
const agentCards = (page: Page) => page.locator('main article[data-run-id]:not(aside[aria-label="Pip"] *)');

/** The stage chip of CA-401's workstream on its peek, at the head of its agents. */
async function stageChip(page: Page) {
  if (!(await peekSheet(page).isVisible())) {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
  }
  return peekSheet(page).locator("#peek-agents [data-stage]");
}

test("in one workstream Pip starts an investigator, a triager, a planner, a builder that opens a draft pull request, and a reviewer of it, each with its own brief", async ({ page }) => {
  test.setTimeout(120_000);
  // The build's draft pull request turns up on the code host only when the test says, so the wait for it can be seen.
  await openApp(page, "runs=empty&prSurface=manual");
  await startWorkstream(page, "CA-401");

  await start(page, "investigate this", "investigate");
  // Queued, launching, working, done.
  await advanceRuns(page, 3);

  const triage = await start(page, "triage this", "triage");
  await expect(await told(page, triage)).toContainText("Start from what R1 reported.");
  await closeSheet(page);
  await advanceRuns(page, 3);

  const plan = await start(page, "plan this", "plan");
  await expect(await told(page, plan)).toContainText("Start from what R1 reported.");
  await closeSheet(page);
  await advanceRuns(page, 3);

  const build = await start(page, "build it", "build");
  const brief = await told(page, build);
  await expect(brief).toContainText("following the plan R3 reported");
  await expect(brief).toContainText("Role: builder.");
  await closeSheet(page);
  const before = await runCount(page);
  await advanceRuns(page, 3);

  // Finished, its draft pull request not found yet: the workstream waits for it and the review is refused.
  const chip = await stageChip(page);
  await expect(chip).toHaveText("Build · waiting for PR");
  await expect(chip).toHaveAttribute("data-waiting-for-pr", /.+/);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .* · Build · waiting for PR$/);
  await ask(page, "review it");
  await expect(pipPane(page)).toContainText(`I couldn't start it: ${NO_PR_YET}`);
  expect(await runCount(page)).toBe(before);

  // The code host shows it, as a sync would find it: the wait ends, and nothing started on its own.
  expect(await surfacePullRequests(page)).toBe(true);
  await expect(chip).toHaveText("Build");
  await expect(chip).not.toHaveAttribute("data-waiting-for-pr");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .* · Build$/);
  expect(await runCount(page)).toBe(before);

  // The review checks out the build's pull request.
  const review = await start(page, "review it", "review");
  await expect(await told(page, review)).toContainText("then checks out pull request");
  await closeSheet(page);
  await advanceRuns(page, 3);
  await expect(await stageChip(page)).toHaveText("Review");

  // The report is prose: the card and the sheet carry no verdict.
  await page.getByRole("button", { name: /^Work(,|$)/ }).click();
  // The review is the workstream's fifth run.
  const card = agentCards(page).filter({ has: page.locator('[data-run-label="R5"]') });
  await expect(card).toHaveAttribute("data-state", "done");
  await expect(card.locator("[data-verdict]")).toHaveCount(0);
  await card.click();
  const sheet = page.locator("#agent-sheet");
  await expect(sheet.locator("[data-verdict]")).toHaveCount(0);
  await expect(sheet.getByRole("list", { name: "Findings" })).toHaveCount(0);
  await expect(sheet).toContainText("the retry loop never backs off");
  expect(await runCount(page)).toBe(before + 1);
});
