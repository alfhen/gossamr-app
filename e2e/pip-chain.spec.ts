import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, detailsOf, openApp, paneSettled as settled, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream, surfacePullRequests } from "./support/app";

// Pip's refusals, as START_BUILD_NEEDS_PLAN and START_REVIEW_NEEDS_TARGET in src-tauri/src/agent/runs.rs.
const BUILD_NEEDS_PLAN = "A build can only follow a finished plan run: pass from_run with the plan run's id from list_runs.";
const REVIEW_NEEDS_BUILD = "A review needs a pull request: pass pr, or from_run with the id of a finished build whose pull request has been found.";
const MARKER = "Marker: the person also wants the unsubscribe link checked.";
// The rest of the refusal of a review whose build's pull request isn't found yet, as WAITING_FOR_PR_HINT in src-tauri/src/inbox/workstreams.rs.
const NO_PR_YET = "that build has no pull request in this repository yet. Gossamr asked GitHub for it";

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
  await expect.poll(async () => (await runIds(page)).filter((r) => r.kind === kind && !before.has(r.id)).length).toBe(1);
  return (await runIds(page)).find((r) => r.kind === kind && !before.has(r.id))!.id;
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
    const mock = (globalThis as { __gossamrMock?: { runs(): { id: string; kind: string }[] } }).__gossamrMock;
    return mock ? mock.runs().map((r) => ({ id: r.id, kind: r.kind })) : [];
  });
const runCount = async (page: Page) => (await runIds(page)).length;

/** The person adds `MARKER` to the Gossamr Plan description draft on CA-401, from its peek, and approves it. */
async function settlePlan(page: Page) {
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
  await draft.getByRole("button", { name: "Edit" }).click();
  const body = draft.getByRole("textbox", { name: "New description, as Markdown" });
  await body.fill((await body.inputValue()).replace(/\n*<\/details>\s*$/, `\n\n${MARKER}\n\n</details>`));
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  // With CA-401 peeked, the pane is its workstream's conversation again.
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

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

test("in one workstream Pip starts investigate, triage with findings, plan, a build that carries the edited plan and a draft pull request, and an adversarial review of it", async ({ page }) => {
  test.setTimeout(120_000);
  // The build's draft pull request turns up on the code host only when the test says, so the wait for it can be seen.
  await openApp(page, "runs=empty&prSurface=manual");
  await startWorkstream(page, "CA-401");

  await start(page, "investigate this", "investigate");
  // Queued, launching, working, done.
  await advanceRuns(page, 3);

  const triage = await start(page, "triage this", "triage");
  await expect(await told(page, triage)).toContainText("The consumer retries failed messages immediately");
  await closeSheet(page);
  await advanceRuns(page, 3);

  const plan = await start(page, "plan this", "plan");
  await expect(await told(page, plan)).toContainText("The consumer retries failed messages immediately");
  await closeSheet(page);
  await advanceRuns(page, 3);

  await settlePlan(page);
  const build = await start(page, "build it", "build");
  const brief = await told(page, build);
  await expect(brief.locator("[data-plan]")).toContainText(MARKER);
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

  // The review follows the build and carries its account.
  const review = await start(page, "review it", "review");
  await expect(await told(page, review)).toContainText("What the builder says it did");
  await closeSheet(page);
  await advanceRuns(page, 3);
  await expect(await stageChip(page)).toHaveText("Review · changes needed");

  // Its blocking verdict is on the Agents card and the run sheet.
  await page.getByRole("button", { name: /^Agents/ }).click();
  // The review is the workstream's fifth run.
  const card = agentCards(page).filter({ has: page.locator('[data-run-label="R5"]') });
  await expect(card).toHaveAttribute("data-state", "done");
  const verdict = card.locator("[data-verdict]");
  await expect(verdict).toHaveAttribute("data-verdict", "blocking");
  await expect(verdict).toHaveAttribute("data-blocking-count", "1");
  await expect(verdict).toHaveText("Blocking · 1");
  await card.click();
  const sheet = page.locator("#agent-sheet");
  await expect(sheet.locator("p[data-verdict]")).toHaveAttribute("data-verdict", "blocking");
  await expect(sheet.locator("p[data-verdict]")).toContainText("Blocking: 1 blocking finding");
  const findings = sheet.getByRole("list", { name: "Findings" }).locator("li");
  await expect(findings).toHaveCount(3);
  await expect(findings.nth(0)).toHaveAttribute("data-severity", "blocking");
  expect(await runCount(page)).toBe(before + 1);
});

test("Pip refuses a build or review that doesn't follow a finished run, says why, and starts nothing", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startWorkstream(page, "CA-401");
  const before = await runCount(page);

  await ask(page, "build it");
  await expect(pipPane(page)).toContainText(`I couldn't start it: ${BUILD_NEEDS_PLAN}`);
  await ask(page, "review it");
  await expect(pipPane(page)).toContainText(`I couldn't start it: ${REVIEW_NEEDS_BUILD}`);
  expect(await runCount(page)).toBe(before);

  await start(page, "plan this", "plan");
  // Queued, launching, working.
  await advanceRuns(page, 2);
  const started = await runCount(page);
  await ask(page, "build it");
  await expect(pipPane(page)).toContainText("I couldn't start it: that plan run hasn't finished");

  await advanceRuns(page, 1);
  await ask(page, "build it");
  await expect(pipPane(page)).toContainText("I couldn't start it: the person hasn't settled the plan yet: they approve or skip the Gossamr Plan draft first");
  expect(await runCount(page)).toBe(started);
});
