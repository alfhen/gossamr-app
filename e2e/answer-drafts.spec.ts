import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, askRun, homeConversation, homeConversationRegion, homeRunCards, homeSettled, homeWakes, inlineStart, jiraWrites, mockRuns, needsYouTray, openApp, openPipHome, peekSheet, startWorkstream, stepChip, stepRail, workstreamEvents, workstreamRow } from "./support/app";

// A workstream in Manage mode, so a run that asks wakes Pip.
const MANAGED = "runs=empty&wsManage=1";
const QUESTION = "Should the refund path keep the old rounding?";

/** Pip's suggested reply to R1 in Pip home's conversation. */
const answerCard = (page: Page) => homeConversationRegion(page).getByRole("article", { name: "Answer for R1" });

/**
 * Starts a workstream on CA-401, has Pip draft its investigation, starts it in place and moves it on to working, then
 * has it ask `QUESTION`; returns the run's id once Pip's wake about it is answered.
 */
async function investigationAsks(page: Page): Promise<string> {
  await openApp(page, MANAGED);
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);
  await askPip(page, "investigate this");
  await homeSettled(page);
  const review = await inlineStart(page, homeRunCards(page, "CA-401").last());
  await review.getByRole("button", { name: "Start agent" }).click();
  await expect(review).toHaveCount(0);
  const id = (await mockRuns(page)).find((r) => r.kind === "investigate")!.id;
  await advanceRuns(page, 2, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("working");
  await homeSettled(page);
  const before = await homeWakes(page).count();
  await askRun(page, id, QUESTION);
  await expect.poll(() => homeWakes(page).count(), { message: "Pip is woken by the question" }).toBeGreaterThan(before);
  await homeSettled(page);
  return id;
}

test("a run's question wakes Pip, which suggests a reply the person checks and sends from the keyboard", async ({ page }) => {
  const id = await investigationAsks(page);
  // Pip says what it did, and only that.
  await expect(homeWakes(page).last()).toContainText(`R1 asks: “${QUESTION}” I drafted a reply for you to check.`);
  const card = answerCard(page);
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-question]")).toHaveText(`R1 asks: ${QUESTION}`);
  await expect(card.locator("[data-reply]")).toContainText("CA-401");
  // One item in the tray for the question and its reply, and the reply under Investigate on the rail.
  const tray = needsYouTray(page).getByRole("button", { name: /^CA-401 · R1 asks a question · Pip suggests a reply · / });
  await expect(tray).toHaveCount(1);
  await expect(needsYouTray(page).getByRole("button", { name: /^CA-401 · R1 asks a question/ })).toHaveCount(1);
  await expect(stepChip(page, "investigate").locator("[data-step-needs-you]")).toHaveText("1 needs you");
  await stepChip(page, "investigate").locator("[data-step-chip]").click();
  await expect(stepRail(page).locator('[data-step-drafts="investigate"]').getByRole("article", { name: "Answer for R1" })).toBeVisible();
  // Nothing was sent: the run still asks.
  expect((await mockRuns(page)).find((r) => r.id === id)?.state).toBe("needsAnswer");

  await card.focus();
  await expect(card.getByRole("status")).toHaveText("a send · s skip · ↵ open");
  await page.keyboard.press("a");
  await expect(card.getByRole("status")).toHaveText("↵ send this reply · any other key cancels");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("working");
  await expect(card).toHaveAttribute("data-state", "applied");
  await expect(needsYouTray(page).getByRole("button", { name: /R1 asks a question/ })).toHaveCount(0);
  const actions = (await workstreamEvents(page)).map((e) => e.action);
  expect(actions).toContain("run_answered");
  expect(actions).toContain("draft_approved");
  expect(actions.indexOf("draft_approved")).toBeGreaterThan(actions.indexOf("run_answered"));
  expect(await jiraWrites(page)).toEqual([]);
});

test("the person edits Pip's suggested reply and sends it with ⌘↵; the run resumes with their words", async ({ page }) => {
  const id = await investigationAsks(page);
  const card = answerCard(page);
  await card.getByRole("button", { name: "Review and answer →" }).click();
  const editor = peekSheet(page).getByRole("textbox", { name: "Reply the agent will get" });
  await expect(editor).toBeVisible();
  await expect(peekSheet(page).locator("[data-question]")).toHaveText(`R1 asks: ${QUESTION}`);
  const mine = "No, use the new rounding on the refund path too, and say so in your result.";
  await editor.fill(mine);
  // Esc leaves the reply with the edit kept and the peek open; the next Esc would close it.
  await editor.press("Escape");
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveValue(mine);
  await expect(peekSheet(page)).toBeVisible();
  await editor.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("working");
  await expect(card).toHaveAttribute("data-state", "applied");
  await expect(card.locator("[data-reply]")).toHaveText(mine);
  // What reached the run is the person's words: the answer is recorded by its length only.
  expect((await workstreamEvents(page)).find((e) => e.action === "run_answered")?.detail).toBe(String([...mine].length));
  const actions = (await workstreamEvents(page)).map((e) => e.action);
  expect(actions).toContain("run_answered");
  expect(actions).toContain("draft_approved");
  expect(await jiraWrites(page)).toEqual([]);
});
