import { expect, test, type Page } from "@playwright/test";
import { agentsHome, closeWorkstreamSheet, groupOpen, needsStack, workstreamSheet, askPip, blockRun, expandNeedsYou, pauseAtCeiling, homeConversation, homeConversationRegion, homeSettled, jiraWrites, keepComments, loseRun, mockAttached, mockRuns, needRow, needsPane, needsPaneHeading, needsYouCount, needsYouTray, openAgents, openApp, selectWorkstream, startWorkstream, workstreamGroup } from "./support/app";

// One Needs you (docs/needs-you.md): what waits on the person is one count everywhere, a filter on Agents, and each
// workstream's decisions are at the top of its detail.


/** The rail's Pip home and Agents buttons. */
const homeButton = (page: Page) => page.locator("[data-rail]").getByRole("button", { name: /^Agents/ });
const agentsButton = (page: Page) => page.getByRole("button", { name: /^Agents/ });

/** Pip home's composer footer, which says how many need the person. */
const footer = (page: Page) => homeConversationRegion(page).locator("[data-composer-footer]");

const need = needRow;

const chip = (page: Page, name: string) => agentsHome(page).locator(`[data-chip="${name}"]`);

/** The sample's run on ticket `key` (the first, when it has several). */
const runOn = async (page: Page, key: string) => (await mockRuns(page)).find((r) => r.key === key)!;
const stateOf = async (page: Page, id: string) => (await mockRuns(page)).find((r) => r.id === id)?.state;

/** The button that opens or hides the need reading `name` in the open detail. */
const needButton = (page: Page, name: RegExp) => workstreamSheet(page).locator("[data-needs-pane]").filter({ hasText: name }).locator("button[data-need-key]");

/** Whether the keyboard is inside the open decision. */
const focusInPane = (page: Page) => page.evaluate(() => !!document.querySelector("[data-needs-pane][data-open]")?.contains(document.activeElement));

/** Pip home with the sample's own runs (a permission, a question, a failure to retry and a quiet run, all in General), ready. */
async function onHome(page: Page, query = "") {
  await openApp(page, query);
  await expect(agentsButton(page)).toHaveCount(1);
  await openAgents(page);
  await expect(needsYouTray(page)).toBeVisible();
}

const expandGeneral = (page: Page) => expandNeedsYou(page, "General");

/** A workstream on CA-401, opened on Pip home. */
async function workstreamOnHome(page: Page) {
  await startWorkstream(page, "CA-401");
  await openAgents(page);
  await selectWorkstream(page, "CA-401");
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
}

test("a workstream's needs are one stack at the top of its detail, most urgent first, and one count on the rail, the chip and under the composer", async ({ page }) => {
  await openApp(page);
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  // The sample leaves CA-401's plan to approve; the workstream gets a pause (the ceiling's) and a draft of Pip's: three needs, one stack.
  await pauseAtCeiling(page, "CA-401");
  await askPip(page, "Draft a comment");
  await homeSettled(page);

  const items = needsStack(page).locator("[data-needs-pane]");
  await expect(items).toHaveCount(3);
  await expect(needsStack(page).locator("[data-workstream-needs-count]")).toHaveText("3");
  // The plan is a decision, which ranks above what is stuck and what waits for an approval.
  await expect(items.nth(0)).toContainText("Approve the plan");
  await expect(items.nth(0)).toContainText("approving its description update is how the plan is approved");
  await expect(items.nth(0).locator("[data-needs-you-chip]")).toHaveText("Decide");
  await expect(items.nth(1)).toContainText("Paused: Pip was woken too often today");
  await expect(items.nth(2)).toContainText("Draft comment");
  // Only one is open at a time: the first, until another is chosen.
  await expect(items.nth(0)).toHaveAttribute("data-open", "true");
  await expect(needsPane(page)).toHaveCount(1);
  await needButton(page, /Paused: Pip was woken too often today/).click();
  await expect(items.nth(1)).toHaveAttribute("data-open", "true");
  await expect(needsPane(page)).toHaveCount(1);

  // General's three (a permission, a question and a failure; a run gone quiet is no need) are one stack too.
  await groupOpen(page, "General").click();
  await expect(needsStack(page).locator("[data-needs-pane]")).toHaveCount(3);

  // The one count: the chip, the rail's badge and the composer say the same six.
  await expect(needsYouCount(page)).toHaveText("6");
  await expect(homeButton(page)).toHaveAccessibleName("Agents, 6 things need you");
  await expect(homeButton(page).locator('[aria-label="6 things need you"]')).toHaveText("6");
  await expect(footer(page)).toHaveText(/ · 6 need you$/);
  await expect(workstreamGroup(page, "CA-401").locator("[data-status]")).toHaveText("Needs you");
  await expect(workstreamGroup(page, "CA-401").locator("[data-status-detail]")).toHaveText("· 3 waiting");
});

test("deciding a permission from the pane: Open in Terminal opens the run there, and the need waits for the person's answer in Terminal", async ({ page }) => {
  await onHome(page);
  await expandGeneral(page);
  const before = await needsYouCount(page).innerText();
  const permission = need(page, /DEVOPS-471.*asks to run a command/);
  await permission.click();

  const pane = needsPane(page);
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("wants to run `git push origin HEAD`.");
  await expect(pane).toContainText("If you wait:");
  await expect(pane).toContainText("The run stays paused; nothing else in DEVOPS-471 moves.");
  await expect(pane.locator("[data-permission-ask]")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Deny" })).toHaveCount(0);

  const run = await runOn(page, "DEVOPS-471");
  expect(await stateOf(page, run.id)).toBe("needsPermission");
  await pane.locator("[data-permission-ask]").getByRole("button", { name: "Open in Terminal" }).click();
  await expect.poll(() => mockAttached(page)).toContain(run.id);
  expect(await stateOf(page, run.id)).toBe("needsPermission");
  await expect(needsYouCount(page)).toHaveText(before);
});

test("answering a question from the pane sends it to the run, which leaves Needs you", async ({ page }) => {
  await onHome(page);
  await expandGeneral(page);
  const before = Number(await needsYouCount(page).innerText());
  await need(page, /CA-409.*asks a question/).click();
  const pane = needsPane(page);
  await expect(pane).toContainText("asks: “Should the refund path keep the old rounding?”");
  await expect(pane).toContainText("The run stays paused until you answer");
  const run = await runOn(page, "CA-409");
  expect(await stateOf(page, run.id)).toBe("needsAnswer");

  const answer = pane.getByRole("textbox", { name: "Your answer" });
  await expect(needsPaneHeading(page)).toBeFocused();
  await answer.fill("Yes, keep the old rounding.");
  await pane.getByRole("button", { name: "Send answer" }).click();
  await expect.poll(() => stateOf(page, run.id)).toBe("working");
  await expect(need(page, /CA-409/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText(String(before - 1));
  // Focus moved on to the next need rather than being lost.
  await expect.poll(() => focusInPane(page)).toBe(true);
});

test("approving a draft from the pane writes it to Jira, and focus goes to the next need; Esc comes back to the list", async ({ page }) => {
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await pauseAtCeiling(page, "CA-401");
  await expect(needsYouCount(page)).toHaveText("2");

  await expect(needsStack(page).locator("[data-needs-pane]").first()).toBeVisible();
  await need(page, /Draft comment/).click();
  const pane = needsPane(page);
  await expect(pane).toContainText("drafted a comment on CA-401.");
  await expect(pane).toContainText("Nothing is written to Jira until you approve it.");
  await expect(pane.locator("article[data-draft]")).toBeVisible();
  expect(await jiraWrites(page)).toEqual([]);

  // Esc hides the decision and leaves the keyboard on the need's own button.
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(needButton(page, /Draft comment/)).toBeFocused();

  await need(page, /Draft comment/).click();
  await pane.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type)).toEqual(["comment"]);
  await expect(need(page, /Draft comment/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText("1");
  // The pause is next: its decision opens in the pane, with Resume.
  await expect(pane).toHaveAttribute("data-kind", "paused");
  await expect(pane.locator("[data-paused-banner]").getByRole("button", { name: "Resume" })).toBeVisible();
  await expect.poll(() => focusInPane(page)).toBe(true);
  await pane.getByRole("button", { name: "Resume" }).click();
  await expect(needsYouCount(page)).toHaveText("0");
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
  await expect(pane).toHaveCount(0);
  await expect(needsStack(page)).toHaveCount(0);
  await expect(homeButton(page)).toHaveAccessibleName("Agents");
  await expect(footer(page)).toHaveText(/nothing needs you$/);
});

test("'Approve N safe drafts' approves comments and moves together after one confirm, with what each does shown first", async ({ page }) => {
  await openApp(page, "runs=empty");
  await expect(agentsButton(page)).toHaveCount(1);
  await workstreamOnHome(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await askPip(page, "move it to QA");
  await homeSettled(page);
  await keepComments(page);
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await expect(needsYouCount(page)).toHaveText("3");

  // The detail offers the batch with the number, above its needs.
  const batch = needsStack(page).getByRole("button", { name: "Approve 3 safe drafts" });
  await batch.click();
  // The preview opens above the needs like any other decision.
  const pane = needsPane(page);
  await expect(pane).toHaveAttribute("data-kind", "batch");
  const preview = pane.locator("[data-needs-you-batch-preview] li");
  await expect(preview).toHaveCount(3);
  await expect(preview.first()).toContainText(/Comment on CA-401|Move CA-401/);
  expect(await jiraWrites(page)).toEqual([]);

  // Cancel keeps them all, and closes the preview.
  await pane.getByRole("button", { name: "Cancel" }).click();
  await expect(pane).toHaveCount(0);
  expect(await jiraWrites(page)).toEqual([]);
  await expect(needsYouCount(page)).toHaveText("3");

  await batch.click();
  await pane.getByRole("button", { name: "Yes, approve 3" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => w.type).sort()).toEqual(["comment", "comment", "transition"]);
  await expect(needsYouCount(page)).toHaveText("0");
  await expect(needsYouTray(page)).toContainText("Nothing needs you.");
});

test("a failure stays in Needs you after Agents is opened, and only a Dismiss (or a fix) takes it out", async ({ page }) => {
  await onHome(page);
  await expandGeneral(page);
  const count = Number(await needsYouCount(page).innerText());
  const failure = need(page, /SUP-9.*needs its folder trusted/);
  await expect(failure).toHaveCount(1);

  // Opening Agents (the failed run is on screen there, as it always was) clears nothing.
  await closeWorkstreamSheet(page);
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first()).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator("[data-rail]").getByRole("button", { name: /^Agents/ })).toHaveAccessibleName(`Agents, ${count} things need you`);
  // Its card says it is in Needs you, and the pill goes to the need.
  const card = page.locator('main article[data-run-id][data-state="failed"]');
  await expect(card.first().locator("[data-in-needs-you]")).toBeVisible();
  await card.first().locator("[data-in-needs-you]").click();
  await expect(agentsHome(page)).toBeVisible();
  await expect(needsPane(page)).toContainText("SUP-9");
  await expect(needsPane(page)).toContainText("Claude asks you once per folder");
  await expect(needsYouCount(page)).toHaveText(String(count));

  // Dismissed, it goes; the run stays in Agents.
  await needsPane(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(need(page, /SUP-9/)).toHaveCount(0);
  await expect(needsYouCount(page)).toHaveText(String(count - 1));
  await chip(page, "needs").click();
  await closeWorkstreamSheet(page);
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first()).toBeVisible();
  await expect(page.locator('main article[data-run-id][data-state="failed"]').first().locator("[data-in-needs-you]")).toHaveCount(0);
  // Remembered across a reload.
  await page.reload();
  await expect(agentsButton(page)).toHaveCount(1);
  await openAgents(page);
  await expect(needsYouCount(page)).toHaveText(String(count - 1));
});

test("a sign-in reads 'needs you to sign in to Claude'; an unclear run, a quiet one and a possible continuation are not in the list", async ({ page }) => {
  await onHome(page, "runs=stuck");
  await expandGeneral(page);
  const signed = await runOn(page, "SUP-12");
  await blockRun(page, signed.id);
  const web = await runOn(page, "WEB-108");
  await loseRun(page, web.id);

  await expect(need(page, /SUP-12.*needs you to sign in to Claude/)).toHaveCount(1);
  await expect(need(page, /SUP-12/)).not.toContainText(/permission/i);
  // The sample's stuck runs: the run Gossamr lost track of, the two that may have carried on elsewhere and the run quiet for 40 minutes are states, not needs.
  await expect(need(page, /WEB-108.*can't read/)).toHaveCount(0);
  await expect(need(page, /CA-278/)).toHaveCount(0);
  await expect(need(page, /CA-279/)).toHaveCount(0);
  await expect(need(page, /CA-377/)).toHaveCount(0);

  await need(page, /SUP-12/).click();
  await expect(needsPane(page).getByRole("group", { name: "Sign-in needed" })).toBeVisible();
  await needsPane(page).getByRole("button", { name: "Open in Terminal" }).click();
  await expect.poll(() => mockAttached(page)).toContain(signed.id);
});

test("a permission has no key to deny it, and e goes to the answer box of a question", async ({ page }) => {
  await onHome(page);
  const card = (key: string) => agentsHome(page).locator("article[data-run-id]").filter({ hasText: key }).first();
  const permission = card("DEVOPS-471");
  await permission.focus();
  // A permission is answered in Terminal: d asks for nothing and changes nothing.
  await page.keyboard.press("d");
  await expect(permission.locator("[data-needs-asking]")).toHaveCount(0);
  const run = await runOn(page, "DEVOPS-471");
  expect(await stateOf(page, run.id)).toBe("needsPermission");

  // e on the question opens its decision with the answer box focused.
  const question = card("CA-409");
  await question.focus();
  await page.keyboard.press("e");
  await expect(needsPane(page).getByRole("textbox", { name: "Your answer" })).toBeFocused();
});
