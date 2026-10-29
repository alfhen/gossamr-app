import { expect, type Page, test } from "@playwright/test";
import {
  advanceRuns, agentsHome, allProjects, askPip, detailsOf, editTicket, expandNeedsYou, expectPeekInPlace, finishOnHome,
  githubWrites, homeConversation, homeConversationRegion, homeSettled, INSTANT_PIP, jiraWrites, MANUAL_PRS, mockRuns,
  needRow, needsPane, needsYouTray, openAgents, openApp, openNeedRow, paneSettled, peekSheet, peekTicket,
  pipConversation, pipPane, runSheet, scriptNextRun, selectWorkstream, showWorkspace, startAgent, startWorkstream,
  ask, stepChip, stepOf, stepRail, surfacePullRequests, wakes, WITH_REPOS, workstreamGroup, workstreamOnHome,
} from "./support/app";
import { finishRun, newest, slowPaneSettled, startStep } from "./support/steps";

/** Moves run `id` on to done, once Pip has answered on Work. */
const finishOnWork = (page: Page, id: string) => finishRun(page, id, homeSettled);

/** Asks Pip for `what` on CA-401 on Work, which starts the agent. */
async function startOnWork(page: Page, what: string) {
  await askPip(page, what);
  await homeSettled(page);
}

/** The state line a step chip shows. */
const chipState = (page: Page, kind: string) => stepChip(page, kind).locator("[data-step-state]");

/** Opens step `kind`'s chip on the rail, unless it is open. */
async function openStep(page: Page, kind: string) {
  const chip = stepChip(page, kind).locator("[data-step-chip]");
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
}

/** Starts `what` and moves the run it made on to done, returning it. */
async function runStep(page: Page, what: string, kind: string) {
  await startStep(page, what);
  const run = (await newest(page, kind))!;
  await finishRun(page, run.id);
  return run;
}

/**
 * From a fresh workstream on CA-401 in the pane to a finished review of its build: the person starts each step through
 * Pip and approves the plan's description update. `before` runs just before the review finishes.
 */
async function toFinishedReview(page: Page, before: () => Promise<void> = async () => {}) {
  await openApp(page, MANUAL_PRS);
  await startWorkstream(page, "CA-401");
  await runStep(page, "investigate this", "investigate");
  await runStep(page, "triage this", "triage");
  await runStep(page, "plan this", "plan");
  await allProjects(page);
  await peekTicket(page, "CA-401");
  const plan = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
  await plan.getByRole("button", { name: "Approve" }).click();
  await expect(plan).toHaveCount(0);
  await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
  await runStep(page, "build it", "build");
  await surfacePullRequests(page);
  await startStep(page, "review it");
  const review = (await newest(page, "review"))!;
  await before();
  await finishRun(page, review.id);
  await paneSettled(page);
  return review;
}

/** Opens CA-401's peek unless it is open, and returns the status word of its workstream at the head of its agents. */
async function peekStage(page: Page) {
  if (!(await peekSheet(page).isVisible())) {
    await allProjects(page);
    await peekTicket(page, "CA-401");
  }
  return peekSheet(page).locator("#peek-agents [data-header-status] [data-status]");
}

/** What Work says of CA-401's workstream: its row, and the conversation's header once it is opened. */
async function homeStage(page: Page) {
  await openAgents(page);
  const row = workstreamGroup(page, "CA-401");
  await row.click();
  return { row, header: homeConversation(page) };
}

/** A fresh profile on the workspace with the sample's repositories watched, so Pip has a clone to start in. */
async function openWatching(page: Page) {
  await page.goto("/?runs=empty&mockRepos=14");
  await page.getByRole("button", { name: "Start watching" }).click();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
}

// The rest of the refusal of a review whose build's pull request isn't found yet, as WAITING_FOR_PR_HINT in src-tauri/src/inbox/workstreams.rs.
const NO_PR_YET = "that build has no pull request yet. Gossamr asked GitHub for it";

const runCard = (page: Page, id: string) => pipPane(page).locator(`article[data-run-id="${id}"]`);

/** Asks Pip for `what` in the pane and waits for its answer. */
async function askInPane(page: Page, what: string) {
  await askPip(page, what);
  await expect(pipPane(page).getByText(what, { exact: true }).last()).toBeVisible();
  await paneSettled(page);
}

/** Asks Pip for `what`, which starts an agent of `kind`; returns its run's id. */
async function start(page: Page, what: string, kind: string) {
  const before = new Set((await runIds(page)).map((r) => r.id));
  await askInPane(page, what);
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

/** The status of CA-401's workstream on its peek, at the head of its agents. */
async function peekHeaderStatus(page: Page) {
  if (!(await peekSheet(page).isVisible())) {
    await allProjects(page);
    await peekTicket(page, "CA-401");
  }
  return peekSheet(page).locator("#peek-agents [data-header-status]");
}

const MARKER = "Marker: also check the unsubscribe link in all three emails.";

const KEY = "CA-408";

const runsOf = async (page: Page, kind: string) => (await mockRuns(page)).filter((r) => r.step === kind);

/** Asks Pip for `what`, which starts it, in the Pip pane or on Work: after the last answer ended, and before the next begins. */
async function askAndSettle(page: Page, what: string, home = false) {
  const settle = home ? homeSettled : paneSettled;
  await settle(page);
  await askPip(page, what);
  await settle(page);
}

/** The id of the `n`th run of `kind`. */
async function nth(page: Page, kind: string, n: number) {
  await expect.poll(async () => (await runsOf(page, kind)).length).toBeGreaterThanOrEqual(n);
  return (await runsOf(page, kind)).map((r) => r.id).reverse()[n - 1];
}

test("asking Pip to investigate starts the agent: no review, and the rail shows R1 running", async ({ page }) => {
  await openApp(page, MANUAL_PRS);
  await workstreamOnHome(page);
  await ask(page, "investigate this");
  // Nothing opened, and the person is still on Pip home with the workstream selected.
  await expect(page.getByRole("dialog", { name: "Start an agent" })).toHaveCount(0);
  await expect(agentsHome(page)).toBeVisible();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
  const r1 = (await newest(page, "investigate"))!;
  expect(r1.state).toBe("queued");
  const chip = stepChip(page, "investigate");
  await expect(chip.locator('[data-run-label="R1"]')).toBeVisible();
  await expect(chip.locator("[data-step-state]")).toHaveText("Queued");

  // Launching, then working: the chip follows it.
  await advanceRuns(page, 2, r1.id);
  await expect(chip.locator("[data-step-state]")).toHaveText("Working");
  await expect(chip).toHaveAttribute("data-state", "working");
  // Opened, the chip shows R1's card.
  await chip.getByRole("button", { expanded: false }).first().click();
  await expect(chip.locator(`article[data-run-id="${r1.id}"]`)).toBeVisible();
});

test("a build follows the approved plan once Pip is asked, and starts with nothing to review", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, MANUAL_PRS);
  await workstreamOnHome(page);

  await ask(page, "investigate this");
  await finishOnWork(page, (await newest(page, "investigate"))!.id);
  await ask(page, "plan this");
  await finishOnWork(page, (await newest(page, "plan"))!.id);
  await expect(stepChip(page, "plan").locator("[data-step-state]")).toHaveText("Ready to review");

  // The plan's description draft opens the ticket's peek, where its diff is read and approved as anywhere.
  const rewrite = homeConversationRegion(page).getByRole("article", { name: "Update the description of CA-401" }).last();
  await rewrite.getByRole("button", { name: "Review on CA-401 →" }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expectPeekInPlace(page);
  await peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" }).getByRole("button", { name: "Approve" }).click();
  await expect(rewrite).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);
  await openAgents(page);
  await selectWorkstream(page, "CA-401");

  await ask(page, "build it");
  await expect(page.getByRole("dialog", { name: "Start an agent" })).toHaveCount(0);
  const build = (await newest(page, "build"))!;
  expect(build.state).toBe("queued");
  await expect(stepChip(page, "build").locator('[data-run-label="R3"]')).toBeVisible();
});

test("intake to a build's pull request on Pip home: the person asks Pip for each step, approves the plan, and Pip is woken for each finish", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, WITH_REPOS);
  await workstreamOnHome(page);
  const row = workstreamGroup(page, "CA-401");
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(stepRail(page).getByRole("switch", { name: "Manage this workstream" })).toHaveCount(0);

  // Asking Pip to investigate starts the agent: nothing waits on the person.
  await askPip(page, "investigate this");
  await homeSettled(page);
  await expect(agentsHome(page)).toBeVisible();
  await expect(needsYouTray(page).locator("[data-needs-you-count]")).toHaveText("0");
  const r1 = (await newest(page, "investigate"))!;
  await expect(stepChip(page, "investigate").locator('[data-run-label="R1"]')).toBeVisible();

  // R1 finishes: one compact wake turn, and nothing starts by itself.
  const wakes = homeConversationRegion(page).locator('[data-turn-kind="wake"]');
  await finishOnHome(page, r1.id);
  await expect(wakes).toHaveCount(1);
  await expect(wakes.first().locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  expect(await newest(page, "triage")).toBeNull();
  // Its header button opens R1's sheet.
  await wakes.first().getByRole("button", { name: "run R1" }).click();
  await expect(page.locator("#agent-sheet")).toBeVisible();
  await page.locator("#agent-sheet").getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.locator("#agent-sheet")).toHaveCount(0);

  // The person asks for the triage and starts it; moving along touches only the rail and the footer, and its finish is a second wake turn.
  await startOnWork(page, "triage this");
  const r2 = (await newest(page, "triage"))!;
  await expect(stepChip(page, "triage").locator('[data-run-label="R2"]')).toBeVisible();
  await homeSettled(page);
  const turns = await homeConversationRegion(page).locator("[data-turn-kind]").count();
  await advanceRuns(page, 2, r2.id);
  await expect(chipState(page, "triage")).toHaveText("Working");
  await expect(homeConversationRegion(page).locator("[data-composer-footer]")).toHaveText(/^1 agent running · /);
  expect(await homeConversationRegion(page).locator("[data-turn-kind]").count()).toBe(turns);
  await finishOnHome(page, r2.id);
  await expect(wakes).toHaveCount(2);
  expect(await newest(page, "plan")).toBeNull();

  // The plan finishes: its description draft is under Plan, never batched, and is approved in the peek over Pip home.
  await startOnWork(page, "plan this");
  const r3 = (await newest(page, "plan"))!;
  await finishOnHome(page, r3.id);
  await openStep(page, "plan");
  const rewrite = stepChip(page, "plan").getByRole("article", { name: "Update the description of CA-401" });
  await expect(rewrite).toBeVisible();
  await expect(stepChip(page, "plan").getByRole("button", { name: /safe drafts/ })).toHaveCount(0);
  await rewrite.getByRole("button", { name: "Review on CA-401 →" }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(agentsHome(page)).toBeVisible();
  // The draft takes the keyboard in the peek, and the window stays where it was around it.
  await expect(peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" })).toBeFocused();
  await expectPeekInPlace(page);
  await peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" }).getByRole("button", { name: "Approve" }).click();
  await expect(rewrite).toHaveCount(0);
  expect((await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["rewrite", "CA-401"]]);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);
  expect(await newest(page, "build")).toBeNull();

  // The approved plan is built on the person's say-so; finished, the build waits for its pull request.
  await startOnWork(page, "build it");
  const r4 = (await newest(page, "build"))!;
  await finishOnHome(page, r4.id);
  await expect(chipState(page, "build")).toHaveText("waiting for PR");
  const pr = stepChip(page, "build").locator("[data-step-pr]");
  await expect(pr).toHaveCount(0);
  expect(await newest(page, "review")).toBeNull();
  // A sync finds the draft pull request: the chip stops waiting and names it, and no review starts by itself.
  await surfacePullRequests(page);
  await expect(pr).toHaveText(/^Draft PR#\d+ CA-401: /);
  await expect(chipState(page, "build")).not.toHaveText("waiting for PR");
  expect(await newest(page, "review")).toBeNull();
  expect(await githubWrites(page)).toEqual([]);
});

test.describe("a workstream's status after a finished review", () => {
  test("a finished review reads Needs you, not Done, on the peek, the pane, the Work row and its header", async ({ page }) => {
    test.setTimeout(120_000);
    // Nothing sends the build back: the review is where the workstream stops.
    await toFinishedReview(page);
    expect((await mockRuns(page)).filter((r) => r.step === "build").map((r) => r.state)).toEqual(["done"]);
    await expect(await peekStage(page)).toHaveText("Needs you");
    await expect(pipPane(page).locator("[data-header-status] [data-status]")).toHaveText("Needs you");
    const { row, header } = await homeStage(page);
    await expect(row).not.toContainText("Done");
    await expect(header.locator("xpath=..").locator("[data-header-status] [data-status]")).toHaveText("Needs you");
    expect((await jiraWrites(page)).map((w) => w.type)).toEqual(["rewrite"]);
  });

  test("a review whose report says it passes leaves the workstream on Needs you", async ({ page }) => {
    test.setTimeout(120_000);
    await toFinishedReview(page, () => scriptNextRun(page, "review", { verdict: "pass" }));
    await expect(wakes(page).last()).toContainText("finished");
    await expect(await peekStage(page)).toHaveText("Needs you");
    const { header } = await homeStage(page);
    await expect(header.locator("xpath=..").locator("[data-header-status] [data-status]")).toHaveText("Needs you");
  });
});

test.describe("approving a plan", () => {
  test("the plan's description draft is pending in the conversation, and approving it is signposted", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, MANUAL_PRS);
    await startWorkstream(page, "CA-401");
    await runStep(page, "investigate this", "investigate");
    await runStep(page, "triage this", "triage");
    await runStep(page, "plan this", "plan");
    await paneSettled(page);
    await expect(pipPane(page).getByRole("button", { name: "Approve the plan" })).toHaveCount(0);
    // The triage's own description update stands above the plan's in the conversation: the plan's is the newer.
    const plan = pipPane(page).getByRole("article", { name: "Update the description of CA-401" }).last();
    await expect(plan).toHaveAttribute("data-state", "pending");
    // Approving the plan is signposted, in Pip's word on the finished plan and on the Plan step, with its open questions.
    await expect(pipPane(page)).toContainText("Approve the description update to let Build start.");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    // The plan's description update is the decision open at the top, so its note is there and not repeated on the rail.
    const note = needsPane(page).locator("[data-plan-approve]");
    await expect(note).toContainText("Approve the description update to let Build start.");
    await expect(note.locator("[data-plan-questions] li").first()).toBeVisible();
  });
});

test.describe("the Review step's pull request", () => {
  test("with no GitHub connection, the Review step opens the pull request on GitHub", async ({ page }) => {
    test.setTimeout(120_000);
    await toFinishedReview(page);
    await page.evaluate(() => {
      const w = window as unknown as { __opened: string[]; open: (url: string) => null };
      w.__opened = [];
      w.open = (url: string) => (w.__opened.push(String(url)), null);
    });
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const open = stepChip(page, "review").getByRole("button", { name: /^Open acme\/storefront#\d+ on GitHub$/ });
    const name = (await open.getAttribute("aria-label"))!.replace(/^Open | on GitHub$/g, "");
    await open.click();
    const [repo, number] = name.split("#");
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([`https://github.com/${repo}/pull/${number}`]);
    await expect(page.getByRole("dialog", { name: /^Pull request / })).toHaveCount(0);
  });
});

test.describe("a plan's description update", () => {
  /** Starts a plan on CA-401 as Pip does and finishes the run, which leaves a description update in the peek. */
  async function planFromPeek(page: Page) {
    const id = await startAgent(page, "CA-401", "plan");
    const run = (await mockRuns(page)).find((r) => r.id === id)!;
    await advanceRuns(page, 3, run.id);
    await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === run.id)?.state).toBe("done");
    if (!(await peekSheet(page).isVisible())) await peekTicket(page, "CA-401");
    // Its short id is given at launch.
    return (await mockRuns(page)).find((r) => r.id === run.id)!;
  }

  test("a second plan that reads as the first offers no description update: the intro names no run, so nothing differs", async ({ page }) => {
    await openWatching(page);
    await peekTicket(page, "CA-401");
    const first = await planFromPeek(page);
    const update = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
    await update.getByRole("button", { name: "Approve" }).click();
    await expect(update).toHaveCount(0);

    const second = await planFromPeek(page);
    expect(first.shortId).not.toBe(second.shortId);
    // The second plan's note to the ticket is drafted, so the plan has finished and its drafts are on the peek.
    await expect(peekSheet(page).getByRole("article", { name: "Comment on CA-401" }).first()).toBeVisible();
    // The intro says who and when, not which run, and this plan reads as the first did: the description has nothing to change,
    // so no update is offered, rather than one whose only difference is a run id.
    await expect(update).toHaveCount(0);
    await expect(peekSheet(page)).not.toContainText(`agent run (${second.shortId})`);
  });
});

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
  const chip = await peekHeaderStatus(page);
  await expect(chip).toContainText("waiting for PR");
  await expect(chip.locator("[data-waiting-for-pr]")).toHaveAttribute("data-waiting-for-pr", /.+/);
  await askInPane(page, "review it");
  await expect(pipPane(page)).toContainText(`I couldn't start it: ${NO_PR_YET}`);
  expect(await runCount(page)).toBe(before);

  // The code host shows it, as a sync would find it: the wait ends, and nothing started on its own.
  expect(await surfacePullRequests(page)).toBe(true);
  await expect(chip).not.toContainText("waiting for PR");
  await expect(chip.locator("[data-waiting-for-pr]")).toHaveCount(0);
  expect(await runCount(page)).toBe(before);

  // The review checks out the build's pull request.
  const review = await start(page, "review it", "review");
  await expect(await told(page, review)).toContainText("then checks out pull request");
  await closeSheet(page);
  await advanceRuns(page, 3);
  await expect(await peekHeaderStatus(page)).toContainText("Needs you");

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

test("a plan the person edited and approved on the ticket is one folded line there, and a build Pip starts is told by its brief", async ({ page }) => {
  await openApp(page);
  await peekTicket(page, "CA-401");
  const draft = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" });
  await draft.getByRole("button", { name: "Edit" }).click();
  const body = draft.getByRole("textbox", { name: "New description, as Markdown" });
  // The person's line goes at the end of the plan, inside its Gossamr Plan expand.
  await body.fill((await body.inputValue()).replace(/\n*<\/details>\s*$/, `\n\n${MARKER}\n\n</details>`));
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Approve" }).click();
  await expect(draft).toHaveCount(0);
  // On the ticket the plan is one folded line: a collapsed details with the summary "Gossamr Plan".
  const folded = peekSheet(page).locator("details").filter({ has: page.locator("summary", { hasText: /^Gossamr Plan$/ }) });
  await expect(folded).toHaveCount(1);
  expect(await folded.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
  await page.keyboard.press("Escape");

  const id = await startAgent(page, "CA-401", "builder", { brief: "Build CA-401 following the plan on the ticket." });
  await page.getByRole("button", { name: /^Work(,|$)/ }).click();
  await page.locator(`main article[data-run-id="${id}"]`).first().click();
  const told = page.locator("#agent-sheet").locator("details").filter({ hasText: "What the agent was told" });
  await told.locator("> summary").first().click();
  await expect(told).toContainText("Build CA-401 following the plan on the ticket.");
});

test("the triage's questions go to the description as a draft, and nothing is posted", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page, INSTANT_PIP);
  await editTicket(page, KEY, { description: "Fix it." });
  await startWorkstream(page, KEY);
  await askAndSettle(page, "investigate this");
  await finishRun(page, await nth(page, "investigate", 1));
  await askAndSettle(page, "triage this");
  await finishRun(page, await nth(page, "triage", 1));
  await openAgents(page);
  await selectWorkstream(page, KEY);

  // The triage's note and open questions are a description update, not a comment on the ticket.
  await expandNeedsYou(page, KEY);
  await expect(needRow(page, /triager · comment/)).toHaveCount(0);
  await openNeedRow(page, "R2 triager · rewrite");
  const update = needsPane(page).getByRole("article", { name: `Update the description of ${KEY}` });
  await expect(update).toBeVisible();
  const diff = update.locator('[data-diff="description"]');
  await expect(diff).toContainText("Triage");
  await expect(diff).toContainText("The ticket cannot be sized yet");
  await expect(diff).toContainText("Open questions:");
  await expect(diff).toContainText("What does done look like for CA-408?");
  await expect(update).toContainText("From the CA-408 triage");
  expect(await jiraWrites(page)).toEqual([]);

  // Every draft the app made waits for the person.
  expect(await jiraWrites(page)).toEqual([]);
});

test.describe("the step rail", () => {
  test("every step of the rail has a state in its name", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    for (const kind of ["investigate", "triage", "plan", "build", "review", "verify"]) await expect(stepChip(page, kind).locator("[data-step-chip]")).toHaveAccessibleName(/Not started/);
  });
});

test.describe("a plan's step", () => {
  test("the plan's step reads Ready to review until its description draft is posted, and Approved after", async ({ page }) => {
    test.setTimeout(150_000);
    await openApp(page, MANUAL_PRS);
    await startWorkstream(page, "CA-401");
    for (const [what, kind] of [["investigate this", "investigate"], ["triage this", "triage"], ["plan this", "plan"]] as const) {
      await startStep(page, what, slowPaneSettled);
      await finishRun(page, (await newest(page, kind))!.id, slowPaneSettled);
    }
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(stepChip(page, "plan").locator("[data-step-state]")).toHaveText("Ready to review");

    await allProjects(page);
    await peekTicket(page, "CA-401");
    const plan = peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).filter({ hasText: "Gossamr Plan" });
    await plan.getByRole("button", { name: "Approve" }).click();
    await expect(plan).toHaveCount(0);
    await expect(pipConversation(page)).toHaveText(/^Workstream: CA-401 /);
    expect(await newest(page, "build")).toBeNull();
    expect(await jiraWrites(page)).toHaveLength(1);

    // The plan's step no longer reads Ready to review: its draft was posted.
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await expect(stepChip(page, "plan").locator("[data-step-state]")).toHaveText("Approved");
  });
});
