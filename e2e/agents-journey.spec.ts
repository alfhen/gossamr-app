import { expect, test, type Page } from "@playwright/test";
import { pauseAtCeiling, advanceRuns, agentsHome, askPip, closeWorkstreamSheet, expandNeedsYou, expectPeekInPlace, finishOnHome, githubWrites, homeConversation, homeConversationRegion, homeSettled, jiraWrites, mockRuns, needRow, needsPane, needsPaneHeading, needsYouCount, needsYouTray, openAgents, openApp, peekSheet, selectWorkstream, startWorkstream, stepChip, stepRail, surfacePullRequests, workstreamEvents, workstreamGroup, openNeedRow, needsStack, openRunOf } from "./support/app";

// Pull requests are shown only when a test says: the setting the phase's scenarios share.
// GitHub is signed in with a catalog small enough to be watched whole, so the agents' repository is watched, as the
// real app needs before it reads a pull request there or drafts a review of one.
const SAMPLE = "runs=empty&prSurface=manual&mockRepos=12";

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.step === kind) ?? null;

/** Asks Pip for `what` on CA-401, which starts the agent. */
async function startOnHome(page: Page, what: string) {
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

/** Starts a workstream on CA-401 from its peek, then selects it on Pip home. */
async function homeWorkstream(page: Page) {
  await startWorkstream(page, "CA-401");
  const ws = (await workstreamEvents(page))[0].workstreamId;
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .+$/);
  return ws;
}

test("intake to a build's pull request on Pip home: the person asks Pip for each step, approves the plan, and Pip is woken for each finish", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, SAMPLE);
  await homeWorkstream(page);
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
  await startOnHome(page, "triage this");
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
  await startOnHome(page, "plan this");
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
  await startOnHome(page, "build it");
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

test("the Needs you list ranks a question from Pip ahead of a pause, opens each in the pane, and each leaves once dealt with", async ({ page }) => {
  await openApp(page, SAMPLE);
  await homeWorkstream(page);
  const row = workstreamGroup(page, "CA-401");
  await expect(needsYouCount(page)).toHaveText("0");

  await askPip(page, "ask me which database to use");
  await homeSettled(page);
  // Pip can still be idle just after the click, before its turn starts; a pause then would cancel the turn before it asks.
  // The question's need being there is the sign the turn is done. Pip's scripted turn can take longer than the default wait
  // on a loaded CI runner, so this one wait is given more time; what it checks is unchanged.
  await expect(needsYouCount(page)).toHaveText("1", { timeout: 15_000 });
  await pauseAtCeiling(page, "CA-401");
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 2 waiting");
  // One row for the workstream; a question for the person ranks ahead of what is stuck (the pause), however old each is (R2).
  await expandNeedsYou(page, "CA-401");
  const titles = needsStack(page).locator("[data-needs-you-need-title]");
  await expect(titles).toHaveText(["Pip asks you", "Paused: Pip was woken too often today"]);

  // From General, the question's need selects the workstream again and opens its decision; dismissed there, it leaves.
  await closeWorkstreamSheet(page);
  await openNeedRow(page, "Pip asks you");
  await expect(needsPane(page)).toContainText("Which database to use?");
  await needsPane(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(needRow(page, "Pip asks you")).toHaveCount(0);
  await expect(row.locator("[data-status]")).toHaveText("Needs you");
  await expect(row.locator("[data-status-detail]")).toHaveText("· 1 waiting");

  // The pane moved on to the pause, with its heading focused (no key lands on Resume by accident); Resume clears the need and the badge.
  await expect(needsPane(page)).toHaveAttribute("data-kind", "paused");
  const resume = needsPane(page).locator("[data-paused-banner]").getByRole("button", { name: "Resume" });
  await expect(needsPaneHeading(page)).toBeFocused();
  await resume.click();
  await expect(needsYouCount(page)).toHaveText("0");
  await expect(row.locator('[data-status="paused"]')).toHaveCount(0);
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
});

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

test("a failed run waits in the list under General, opens its decision, and stays until it is dealt with, not just seen", async ({ page }) => {
  await openApp(page, "prSurface=manual");
  await openAgents(page);
  await expandNeedsYou(page);
  // The sample's failed run failed on a folder it may not use yet, so it waits as a failure with a step to take.
  const failed = needRow(page, /SUP-9.*needs its folder trusted/);
  await expect(failed).toHaveCount(1);
  await expect(failed).toHaveAttribute("data-kind", "failure");
  await failed.click();
  await expect(needsPane(page)).toContainText("Trust this folder in Terminal");
  // The run's own card opens its sheet over Agents.
  await openRunOf(page, "SUP-9");
  const sheet = page.getByRole("dialog", { name: "Agent run" });
  await expect(sheet.first()).toBeVisible();
  await expect(agentsHome(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Agents shows the failure, and showing it clears nothing: back on Pip home it still waits (R5).
  await openAgents(page);
  await expandNeedsYou(page);
  await expect(needRow(page, /SUP-9.*needs its folder trusted/)).toHaveCount(1);
});

