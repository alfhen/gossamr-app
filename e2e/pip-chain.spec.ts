import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, openApp, peekSheet, peekTicket, pipConversation, pipPane, startWorkstream, surfacePullRequests } from "./support/app";

// Pip's refusals, as BUILD_NEEDS_PLAN and REVIEW_NEEDS_BUILD in src-tauri/src/agent/runs.rs.
const BUILD_NEEDS_PLAN = "A build can only follow a finished plan run: pass from_run with the plan run's id from list_runs. Pip can't propose a build or review on its own.";
const REVIEW_NEEDS_BUILD = "A review can only follow a finished build whose pull request has been found: pass from_run with the build run's id from list_runs. Pip can't propose a build or review on its own.";
const MARKER = "Marker: the person also wants the unsubscribe link checked.";
// The rest of the refusal of a review whose build's pull request isn't found yet, as WAITING_FOR_PR_HINT in src-tauri/src/inbox/workstreams.rs.
const NO_PR_YET = "that build has no pull request in this repository yet. Gossamr asked GitHub for it";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
/** Pip's run drafts on CA-401 in the pane. */
const runCards = (page: Page) => pipPane(page).getByRole("article", { name: "Start an agent: CA-401" });

/** Waits until Pip has finished answering in the pane. */
async function settled(page: Page) {
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

/** Asks Pip for `what` and waits for its answer. */
async function ask(page: Page, what: string) {
  await askPip(page, what);
  await expect(pipPane(page).getByText(what, { exact: true }).last()).toBeVisible();
  await settled(page);
}

/** Opens Pip's newest run draft in the setup sheet, past the safety sheet a fresh profile shows once at its first agent action. */
async function openNewestDraft(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await runCards(page).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
    await expect(safety(page)).toHaveCount(0);
  }
  await expect(setup(page)).toContainText("CA-401");
}

/** The whole prompt as the setup sheet shows it. */
async function wholePrompt(page: Page) {
  const whole = setup(page).locator("details").filter({ hasText: "Show the whole prompt as one piece" });
  await whole.locator("summary").click();
  return (await whole.locator("pre").textContent()) ?? "";
}

/** Asks Pip for `what`, opens the draft it made and starts it; returns the prompt the person approved. */
async function draftAndStart(page: Page, what: string) {
  await ask(page, what);
  await expect(runCards(page).last()).toBeVisible();
  await openNewestDraft(page);
  const prompt = await wholePrompt(page);
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
  await expect(page.getByText("Agent started on CA-401.", { exact: false }).last()).toBeVisible();
  return prompt;
}

/** The runs the sample backend holds, through `__gossamrMock` (exposeMockClock in src/backend/mockWatch.ts). */
const runCount = (page: Page) =>
  page.evaluate(() => {
    const mock = (globalThis as { __gossamrMock?: { runs(): unknown[] } }).__gossamrMock;
    return mock ? mock.runs().length : -1;
  });

/** The person adds `MARKER` to the Gossamr Plan description draft on CA-401, from its peek, and approves it. */
async function settlePlan(page: Page) {
  await page.getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
  await draft.getByRole("button", { name: "Edit" }).click();
  const body = draft.getByRole("textbox", { name: "New description, as Markdown" });
  await body.fill(`${await body.inputValue()}\n\n${MARKER}`);
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
    await page.getByRole("button", { name: "All projects" }).click();
    await peekTicket(page, "CA-401");
  }
  return peekSheet(page).locator("#peek-agents [data-stage]");
}

test("in one workstream Pip drafts investigate, triage with findings, plan, a build that carries the edited plan and a draft pull request, and an adversarial review of it", async ({ page }) => {
  // Every step of the chain, each started by the person.
  test.setTimeout(120_000);
  // The build's draft pull request turns up on the code host only when the test says, so the wait for it can be seen.
  await openApp(page, "runs=empty&prSurface=manual");
  await startWorkstream(page, "CA-401");

  await draftAndStart(page, "investigate this");
  // Queued, launching, working, done.
  await advanceRuns(page, 3);

  const triage = await draftAndStart(page, "triage this");
  expect(triage).toContain("<<<FINDINGS\nThe consumer retries failed messages immediately");
  expect(triage.indexOf("FINDINGS>>>")).toBeLessThan(triage.indexOf("<<<TICKET"));
  await advanceRuns(page, 3);

  const plan = await draftAndStart(page, "plan this");
  expect(plan).toContain("<<<FINDINGS\nThe consumer retries failed messages immediately");
  await advanceRuns(page, 3);

  await settlePlan(page);
  const before = await runCount(page);
  await ask(page, "build it");
  await expect(pipPane(page)).toContainText("I drafted a build of CA-401 following plan run");
  await openNewestDraft(page);
  await expect(setup(page).locator("[data-pip-chain]")).toContainText("Drafted by Pip from run");
  await expect(setup(page).locator("[data-pip-chain]")).toContainText("the plan below was filled in by Gossamr from that run");
  await expect(setup(page)).toContainText("This build follows the plan from run");
  await expect(setup(page).getByRole("textbox", { name: /^Plan from run / })).toHaveValue(new RegExp(MARKER));
  const prompt = await wholePrompt(page);
  expect(prompt).toContain("A person read, edited and approved the plan below.");
  expect(prompt).toContain(MARKER);
  expect(prompt).toContain("gh pr create --draft");
  expect(prompt).toContain("Never mark the pull request ready");
  const push = setup(page).locator("[data-push-locked]");
  await expect(push.getByRole("checkbox")).toBeChecked();
  await expect(push.getByRole("checkbox")).toBeDisabled();
  await expect(push).toContainText("Builds in a workstream always push their branch and open a draft pull request. The prompt says never mark it ready and never merge it.");
  // Reading it starts nothing; only Start agent would.
  expect(await runCount(page)).toBe(before);

  // Build from this plan, on the plan run's sheet, opens Pip's draft rather than making a second one.
  const id = await setup(page).locator("[data-pip-chain]").textContent();
  await setup(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(setup(page)).toHaveCount(0);
  if (!(await peekSheet(page).isVisible())) await peekTicket(page, "CA-401");
  await peekSheet(page).locator("#peek-agents button").filter({ has: page.locator('[data-run-label="R3"]') }).click();
  await page.getByRole("button", { name: "Build from this plan" }).click();
  await expect(setup(page).locator("[data-pip-chain]")).toHaveText(id ?? "");
  // A second draft would be the person's own.
  await expect(setup(page)).toContainText("Proposed by Pip. Nothing has started.");
  await setup(page).getByRole("button", { name: "Close", exact: true }).first().click();
  expect(await runCount(page)).toBe(before);

  // Approving Pip's build is the only way it starts.
  await openNewestDraft(page);
  await expect(setup(page).locator("[data-pip-chain]")).toHaveText(id ?? "");
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
  await expect(page.getByText("Agent started on CA-401.", { exact: false }).last()).toBeVisible();
  expect(await runCount(page)).toBe(before + 1);
  await advanceRuns(page, 3);

  // Finished, its draft pull request not found yet: the workstream waits for it and the review is refused.
  const chip = await stageChip(page);
  await expect(chip).toHaveText("Build · waiting for PR");
  await expect(chip).toHaveAttribute("data-waiting-for-pr", /.+/);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .* · Build · waiting for PR$/);
  const reviewDrafts = await runCards(page).count();
  await ask(page, "review it");
  await expect(pipPane(page)).toContainText(`I couldn't draft that: ${NO_PR_YET}`);
  await expect(runCards(page)).toHaveCount(reviewDrafts);

  // The code host shows it, as a sync would find it: the wait ends, and nothing started on its own.
  expect(await surfacePullRequests(page)).toBe(true);
  await expect(chip).toHaveText("Build");
  await expect(chip).not.toHaveAttribute("data-waiting-for-pr");
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 .* · Build$/);
  expect(await runCount(page)).toBe(before + 1);

  // The review is pinned to the build's pull request, carries its account, is adversarial and reports a verdict.
  await ask(page, "review it");
  await expect(pipPane(page)).toContainText("I drafted a review of CA-401 following build run");
  await expect(runCards(page)).toHaveCount(reviewDrafts + 1);
  await openNewestDraft(page);
  await expect(setup(page).locator("[data-pip-chain]")).toContainText("the account below was filled in by Gossamr from that run");
  await expect(setup(page)).not.toContainText("Focus from Pip");
  const review = await wholePrompt(page);
  expect(review).toMatch(/Review pull request #300 in acme\/storefront at commit [0-9a-f]{40}\./);
  expect(review).toContain("Your job is to show that the change is not ready");
  expect(review).toContain("it never comments on, approves, requests changes on or otherwise changes the pull request");
  expect(review).toContain("pushed the branch and opened a draft pull request");
  expect(review).toContain("verdict ('pass' or 'blocking', required)");
  expect(review).toContain("findings (an array of objects with severity blocking, should-fix or nit");
  expect(await runCount(page)).toBe(before + 1);
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
  expect(await runCount(page)).toBe(before + 2);
  await advanceRuns(page, 3);
  // Starting it opened the Agents view; the workstream's stage is read on the ticket's peek again.
  await expect(await stageChip(page)).toHaveText("Done");

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
  expect(await runCount(page)).toBe(before + 2);
});

test("Pip refuses a build or review that doesn't follow a finished run, says why, and drafts nothing", async ({ page }) => {
  await openApp(page, "runs=empty");
  await startWorkstream(page, "CA-401");
  const before = await runCount(page);

  await ask(page, "build it");
  await expect(pipPane(page)).toContainText(`I couldn't draft that: ${BUILD_NEEDS_PLAN}`);
  await ask(page, "review it");
  await expect(pipPane(page)).toContainText(`I couldn't draft that: ${REVIEW_NEEDS_BUILD}`);
  await expect(runCards(page)).toHaveCount(0);
  expect(await runCount(page)).toBe(before);

  await draftAndStart(page, "plan this");
  // Queued, launching, working.
  await advanceRuns(page, 2);
  const started = await runCount(page);
  const drafts = await runCards(page).count();
  await ask(page, "build it");
  await expect(pipPane(page)).toContainText("I couldn't draft that: that plan run hasn't finished");

  await advanceRuns(page, 1);
  await ask(page, "build it");
  await expect(pipPane(page)).toContainText("I couldn't draft that: the person hasn't settled the plan yet: they approve or skip the Gossamr Plan draft first");
  await expect(runCards(page)).toHaveCount(drafts);
  expect(await runCount(page)).toBe(started);
});
