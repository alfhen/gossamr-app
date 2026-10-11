import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  agentsSettled,
  expectPeekInPlace,
  finishOnHome,
  homeConversation,
  homeConversationRegion,
  homeRunCards,
  homeSettled,
  inlineStart,
  jiraWrites,
  mockRuns,
  needsYouTray,
  openApp,
  openPipHome,
  peekSheet,
  pipHome,
  scriptNextRun,
  setBudget,
  startWorkstream,
  stepChip,
  stepRail,
  surfacePullRequests,
  workstreamEvents,
  workstreamRow,
} from "./support/app";

// A workstream in Manage mode, with pull requests shown only when a test says: the setting the phase's scenarios share.
const MANAGED = "runs=empty&prSurface=manual&wsManage=1";

/** The newest run of `kind`, as the sample backend holds it. */
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;

/** Waits for the next run of `kind` to have been started by a rule and returns it. */
async function started(page: Page, kind: string, after: string | null = null) {
  await expect.poll(async () => (await newest(page, kind))?.id ?? null).not.toBe(after);
  return (await newest(page, kind))!;
}


/** The state line, the verdict and the fix round a step chip shows. */
const chipState = (page: Page, kind: string) => stepChip(page, kind).locator("[data-step-state]");

/** Opens step `kind`'s chip on the rail, unless it is open. */
async function openStep(page: Page, kind: string) {
  const chip = stepChip(page, kind).locator("[data-step-chip]");
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
}

/** Starts a workstream on CA-401 from its peek, with room for every automatic turn of the chain, then selects it on Pip home. */
async function homeWorkstream(page: Page) {
  await startWorkstream(page, "CA-401");
  const ws = (await workstreamEvents(page))[0].workstreamId;
  await setBudget(page, ws, { autoTurns: 12 });
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  return ws;
}

test("intake to review on Pip home: the person talks to Pip, starts the investigation in place, approves the plan and the review's comments, and the rules do the rest", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, MANAGED);
  await agentsSettled(page);
  await homeWorkstream(page);
  const row = workstreamRow(page, "CA-401");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row.locator("[data-stage]")).toHaveText("Intake");
  await expect(stepRail(page).getByRole("switch", { name: "Manage this workstream" })).toHaveAttribute("aria-checked", "true");

  // The workstream's own suggestion asks Pip to investigate: a draft, in the conversation and under Investigate.
  await homeConversationRegion(page).getByRole("button", { name: "Investigate CA-401", exact: true }).click();
  await homeSettled(page);
  await expect(homeRunCards(page, "CA-401")).toHaveCount(1);
  await expect(stepChip(page, "investigate").locator("[data-step-needs-you]")).toHaveText("1 needs you");
  await expect(row.locator("[data-needs-you-badge]")).toHaveText("1 needs you");
  await expect(needsYouTray(page).locator("[data-needs-you-count]")).toHaveText("1");

  // Read in place and started there: no sheet, still Pip home.
  const review = await inlineStart(page, homeRunCards(page, "CA-401").last());
  await expect(review.locator("[data-inline-prompt]")).toBeVisible();
  await review.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByRole("dialog", { name: "Start an agent" })).toHaveCount(0);
  await expect(review).toHaveCount(0);
  await expect(pipHome(page)).toBeVisible();
  await expect(needsYouTray(page).locator("[data-needs-you-count]")).toHaveText("0");
  const r1 = (await newest(page, "investigate"))!;
  await expect(stepChip(page, "investigate").locator('[data-run-label="R1"]')).toBeVisible();

  // R1 finishes: one compact wake turn, and Triage R2 starts by the rule.
  const wakes = homeConversationRegion(page).locator('[data-turn-kind="wake"]');
  await finishOnHome(page, r1.id);
  await expect(wakes).toHaveCount(1);
  await expect(wakes.first().locator("[data-wake-header]")).toHaveText("Pip picked this up: run R1 finished");
  const r2 = await started(page, "triage");
  await expect(stepChip(page, "triage").locator("[data-step-auto]")).toHaveText("· started automatically");
  // Its header button shows R1 on the rail.
  await wakes.first().getByRole("button", { name: "run R1" }).click();
  await expect(stepChip(page, "investigate").locator(`article[data-run-id="${r1.id}"]`)).toBeFocused();

  // R2 moving along touches only the rail and the footer; its finish starts Plan R3 with a second wake turn.
  await homeSettled(page);
  const turns = await homeConversationRegion(page).locator("[data-turn-kind]").count();
  await advanceRuns(page, 2, r2.id);
  await expect(chipState(page, "triage")).toHaveText("Working");
  await expect(homeConversationRegion(page).locator("[data-composer-footer]")).toHaveText(/^1 agent working · /);
  expect(await homeConversationRegion(page).locator("[data-turn-kind]").count()).toBe(turns);
  await finishOnHome(page, r2.id);
  await expect(wakes).toHaveCount(2);
  const r3 = await started(page, "plan");
  await expect(stepChip(page, "plan").locator("[data-step-auto]")).toBeVisible();

  // The plan finishes: its description draft is under Plan, never batched, and is approved in the peek over Pip home.
  await finishOnHome(page, r3.id);
  await openStep(page, "plan");
  const rewrite = stepChip(page, "plan").getByRole("article", { name: "Update the description of CA-401" });
  await expect(rewrite).toBeVisible();
  await expect(stepChip(page, "plan").getByRole("button", { name: /^Approve these/ })).toHaveCount(0);
  await rewrite.getByRole("button", { name: "Review on CA-401 →" }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  await expect(pipHome(page)).toBeVisible();
  // The draft takes the keyboard in the peek, and the window stays where it was around it.
  await expect(peekSheet(page).getByRole("article", { name: "Update the description of CA-401" })).toBeFocused();
  await expectPeekInPlace(page);
  await peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).getByRole("button", { name: "Update description" }).click();
  await expect(rewrite).toHaveCount(0);
  expect((await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["rewrite", "CA-401"]]);
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);

  // The approved plan starts Build R4; finished, it waits for its pull request, then Review R5 starts.
  const r4 = await started(page, "build");
  await expect(stepChip(page, "build").locator("[data-step-auto]")).toBeVisible();
  await finishOnHome(page, r4.id);
  await expect(chipState(page, "build")).toHaveText("waiting for PR");
  const pr = stepChip(page, "build").locator("[data-step-pr]");
  await expect(pr).toHaveCount(0);
  expect(await newest(page, "review")).toBeNull();
  // A sync finds the draft pull request: the chip stops waiting and names it, before anything else happens on the rail.
  await surfacePullRequests(page);
  await expect(pr).toHaveText(/^Draft PR#\d+ CA-401: /);
  await expect(chipState(page, "build")).not.toHaveText("waiting for PR");
  const r5 = await started(page, "review");
  await expect(stepChip(page, "review").locator("[data-step-auto]")).toBeVisible();

  // The default review blocks: the verdict on the chip, and the build goes into fix round 1.
  await finishOnHome(page, r5.id);
  await expect(stepChip(page, "review").locator("[data-step-verdict]")).toHaveText(/^· Blocking · \d+$/);
  await expect(stepChip(page, "build").locator("[data-step-fix-round]")).toHaveText("· fix round 1/2");
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === r4.id)?.state).toBe("working");

  // The fix round finishes, a second review is scripted to pass.
  await finishOnHome(page, r4.id);
  await surfacePullRequests(page);
  const r6 = await started(page, "review", r5.id);
  await scriptNextRun(page, "review", { verdict: "pass" });
  await finishOnHome(page, r6.id);
  await expect(stepChip(page, "review").locator("[data-step-verdict]")).toHaveText("· Pass");
  await homeSettled(page);

  // The two reviews' comment drafts go together, after a confirm: one write each.
  await openStep(page, "review");
  const drafts = stepChip(page, "review").locator('article[data-draft][data-state="pending"]');
  await expect(drafts).toHaveCount(2);
  const ids = await drafts.evaluateAll((els) => els.map((el) => el.getAttribute("data-draft")));
  const inTray = needsYouTray(page).locator("[data-needs-you-item]");
  const trayBefore = await inTray.count();
  const ask = stepChip(page, "review").getByRole("button", { name: "Approve these 2" });
  await ask.click();
  const confirm = stepChip(page, "review").getByRole("group", { name: "Approve 2 drafts" });
  await expect(confirm.getByRole("button", { name: "Yes, approve 2" })).toBeFocused();
  // Esc cancels with nothing written.
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  expect((await jiraWrites(page)).length).toBe(1);
  await ask.click();
  await confirm.getByRole("button", { name: "Yes, approve 2" }).click();
  await expect(stepChip(page, "review").locator("[data-batch-outcome]")).toHaveText("Approved 2.");
  await expect
    .poll(async () =>
      (await jiraWrites(page))
        .filter((w) => w.type === "comment")
        .map((w) => w.proposalId)
        .sort(),
    )
    .toEqual([...ids].sort());
  await expect(inTray).toHaveCount(trayBefore - 2);
  await expect(pipHome(page)).toBeVisible();
});

test("the Needs you tray lists a draft and a hold oldest first, goes to each, and each leaves once dealt with", async ({ page }) => {
  await openApp(page, MANAGED);
  await agentsSettled(page);
  await homeWorkstream(page);
  const row = workstreamRow(page, "CA-401");
  const items = needsYouTray(page).locator("[data-needs-you-item]");
  await expect(items).toHaveCount(0);

  await homeConversationRegion(page).getByRole("button", { name: "Investigate CA-401", exact: true }).click();
  await homeSettled(page);
  await stepRail(page).getByRole("button", { name: "Hold", exact: true }).click();
  await expect(row.locator("[data-needs-you-badge]")).toHaveText("2 need you");
  // Oldest first: the draft came before the hold, which sorts by when it was held.
  await expect.poll(async () => (await items.allTextContents()).map((l) => l.replace(/ · (?:now|\d+[mhd])$/, ""))).toEqual(["CA-401 · Start Investigate", "CA-401 · Held by you"]);

  // From General, the draft's item selects the workstream again and focuses its card; skipped there, it leaves.
  await workstreamRow(page, "General").click();
  await items.first().click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(homeRunCards(page, "CA-401").last()).toBeFocused();
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  await expect(items).toHaveCount(1);
  await expect(row.locator("[data-needs-you-badge]")).toHaveText("1 needs you");

  // The hold's item goes to Resume, which clears it and the badge.
  await workstreamRow(page, "General").click();
  await items.first().click();
  const resume = pipHome(page).locator("[data-held-banner]").getByRole("button", { name: "Resume" });
  await expect(resume).toBeFocused();
  await resume.click();
  await expect(items).toHaveCount(0);
  await expect(row.locator("[data-needs-you-badge]")).toHaveCount(0);
});

test("a failed run waits in the tray under General, opens its sheet over Pip home, and leaves once the failures were seen", async ({ page }) => {
  await openApp(page, "prSurface=manual");
  await agentsSettled(page);
  await openPipHome(page);
  // The sample's failed run failed on a folder it may not use yet, so it waits as a permission to give.
  const failed = needsYouTray(page).getByRole("button", { name: /^SUP-9 · .* needs its folder trusted · / });
  await expect(failed).toHaveCount(1);
  await expect(failed).toHaveAttribute("data-kind", "permission");
  await failed.click();
  await expect(workstreamRow(page, "General")).toHaveAttribute("aria-selected", "true");
  const sheet = page.getByRole("dialog").filter({ hasText: "SUP-9" });
  await expect(sheet.first()).toBeVisible();
  await expect(pipHome(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // The Agents view is where failures are seen; back on Pip home it is gone from the tray.
  await page.getByRole("button", { name: /^Agents/ }).click();
  await expect(pipHome(page)).toHaveCount(0);
  await openPipHome(page);
  await expect(failed).toHaveCount(0);
});

test("on a window about 900px wide the steps drop below the conversation, nothing scrolls sideways, and F6 still goes list, conversation, steps", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openApp(page, MANAGED);
  await agentsSettled(page);
  await homeWorkstream(page);
  const conversation = homeConversationRegion(page);
  const steps = stepRail(page);
  const c = (await conversation.boundingBox())!;
  const s = (await steps.boundingBox())!;
  expect(s.y).toBeGreaterThanOrEqual(c.y + c.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await workstreamRow(page, "CA-401").focus();
  await page.keyboard.press("F6");
  await expect(pipHome(page).locator("#pip-input")).toBeFocused();
  await page.keyboard.press("F6");
  await expect(stepChip(page, "investigate").locator("[data-step-chip]")).toBeFocused();
  await page.keyboard.press("F6");
  await expect(workstreamRow(page, "CA-401")).toBeFocused();
  await page.keyboard.press("Shift+F6");
  await expect(stepChip(page, "investigate").locator("[data-step-chip]")).toBeFocused();
});
