import { expect, type Page, test } from "@playwright/test";
import { advanceRuns, agentsHome, expandNeedsYou, expectToast, mockAnswerTries, mockRuns, needRow, needsPane, openAgents, openApp, openRunOf, pipPane, runSheet } from "./support/app";

/** Said when an answer goes to a run handed over to Terminal; `HANDED_OVER_ASK` in src/types.ts. */
const HANDED_OVER = "It was handed over to Terminal. Say whether you took it back there before Gossamr resumes it.";
/** Why Clean up leaves a run Terminal works in; `HANDED_OVER_CLEANUP` in src/types.ts. */
const HANDED_OVER_CLEANUP = "Handed over to Terminal, which works in its worktree. Message the agent and press I took it back, or remove the worktree yourself once you are done there, then Clean up.";

const card = (page: Page, key: string) => agentsHome(page).locator("article[data-run-id]").filter({ hasText: key }).first();
const runOf = async (page: Page, key: string) => (await mockRuns(page)).find((r) => r.key === key)!;

async function sheetOf(page: Page, key: string) {
  await openRunOf(page, key);
  await expect(runSheet(page)).toBeVisible();
  return runSheet(page);
}

test.beforeEach(async ({ page }) => {
  await openApp(page, "runs=harness");
  await openAgents(page);
});

test("a run whose commit the signing app refused says so, offers no Retry, and asks Pip to start it again", async ({ page }) => {
  await expect(card(page, "CA-405")).toContainText("Git couldn't sign a commit, so the agent stopped.");
  const sheet = await sheetOf(page, "CA-405");
  await expect(sheet).toContainText("The run stopped without finishing");
  await expect(sheet).toContainText("Unlock it or check its settings, then ask Pip to start the agent again.");
  await expect(sheet.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Ask Pip to start it again" }).click();
  await expect(pipPane(page).getByText("Ask Pip to start it again").last()).toBeVisible();
  await expect(page.locator("[data-toast]").filter({ hasText: "Couldn't" })).toHaveCount(0);
});

test("an interrupted agent's Clean up asks first, Keep it and Esc leave it, and Yes removes the worktree", async ({ page }) => {
  await expect(card(page, "WEB-106")).toContainText("Gossamr stopped this agent when it updated how agents run.");
  const sheet = await sheetOf(page, "WEB-106");
  await expect(sheet).toContainText("Clean up removes the worktree with git");
  const cleanUp = sheet.getByRole("button", { name: "Clean up", exact: true });
  await expect(cleanUp).toHaveCount(1);
  await cleanUp.click();
  const ask = sheet.getByRole("group", { name: "Clean up this run" });
  await expect(ask).toContainText("Remove the worktree?");
  await ask.getByRole("button", { name: "Keep it" }).click();
  await expect(ask).toHaveCount(0);
  await cleanUp.click();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await cleanUp.click();
  await ask.getByRole("button", { name: "Yes, remove it" }).click();
  await expect(sheet).toContainText("Its worktree was removed.");
  await expect(sheet.getByRole("button", { name: "Clean up", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Ask Pip to start it again" })).toBeVisible();
});

test("Needs you lists the signing and interrupted runs with their summaries and the step each offers first", async ({ page }) => {
  await expandNeedsYou(page);
  await needRow(page, /CA-405/).click();
  await expect(needsPane(page)).toContainText("Git couldn't sign a commit, so the agent stopped.");
  await expect(needsPane(page).getByRole("button", { name: "Ask Pip to start it again" })).toBeVisible();
  await needRow(page, /WEB-106/).click();
  await expect(needsPane(page)).toContainText("Gossamr stopped this agent when it updated how agents run.");
  await expect(needsPane(page).getByRole("button", { name: "Clean up", exact: true })).toBeVisible();
  await expect(needsPane(page).getByRole("button", { name: /^Retry/ })).toHaveCount(0);
});

test("Clean up on a card asks first, keeps j and k inside its question, and removes the worktree on Yes", async ({ page }) => {
  const web = card(page, "WEB-106");
  await web.getByRole("button", { name: "Clean up", exact: true }).click();
  const ask = web.getByRole("group", { name: "Clean up this run" });
  const yes = ask.getByRole("button", { name: "Yes, remove it" });
  await expect(yes).toBeFocused();
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await expect(yes).toBeFocused();
  await expect(runSheet(page)).toHaveCount(0);
  await yes.click();
  await expect(web.getByRole("button", { name: "Clean up", exact: true })).toHaveCount(0);
  await expect(web.getByRole("button", { name: "Ask Pip to start it again" })).toBeVisible();
});

test("a refused clean-up shows its reason in its own words and removes nothing", async ({ page }) => {
  const sheet = await sheetOf(page, "DEVOPS-490");
  await sheet.getByRole("button", { name: "Clean up", exact: true }).click();
  await sheet.getByRole("group", { name: "Clean up this run" }).getByRole("button", { name: "Yes, remove it" }).click();
  await expect(sheet.getByRole("alert")).toHaveText(/kept it: The worktree has unpushed commits\. Push them or discard them yourself, then try again\.$/);
  await expect(sheet).not.toContainText("The worktree and its branch were removed.");
});

test("Clean up finished runs takes runs on the harness, and leaves the one Terminal works in, saying why", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agent settings");
  await page.keyboard.press("Enter");
  const settings = page.getByRole("dialog", { name: "Agent settings" });
  await settings.getByRole("button", { name: /^Clean up finished runs \(\d+\)$/ }).click();
  await expectToast(page, `Couldn't clean it up: ${HANDED_OVER_CLEANUP}`);
  await expect(settings.getByRole("status")).toHaveText(/^Removed \d+ worktrees\. 1 kept: The worktree has unpushed commits\./);
});

test("a run handed over to Terminal says so on its card, why in Needs you, and sends the answer once, only on I took it back", async ({ page }) => {
  await expect(card(page, "SUP-13")).toContainText("Handed over to Terminal");
  await expandNeedsYou(page);
  await needRow(page, /SUP-13/).click();
  const pane = needsPane(page);
  await expect(pane.getByRole("status").filter({ hasText: HANDED_OVER })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Send answer" })).toHaveCount(0);
  const box = pane.getByRole("textbox", { name: "Your answer" });
  // Plain keys are the person's text here, and ⌘↵ doesn't send for a run handed over.
  await box.fill("");
  await box.pressSequentially("jk yes");
  await expect(box).toHaveValue("jk yes");
  await expect(pane).toContainText("SUP-13");
  await box.press("ControlOrMeta+Enter");
  // A send would have reached the mock by now; it answers at once.
  await page.waitForTimeout(500);
  expect(await mockAnswerTries(page)).toEqual([]);
  expect((await runOf(page, "SUP-13")).state).toBe("needsAnswer");
  await expect(page.locator("[data-toast]").filter({ hasText: "Answer sent" })).toHaveCount(0);
  await pane.getByRole("button", { name: "I took it back" }).click();
  await expect(needRow(page, /SUP-13/)).toHaveCount(0);
  expect((await runOf(page, "SUP-13")).state).toBe("working");
  expect(await mockAnswerTries(page)).toEqual([(await runOf(page, "SUP-13")).id]);
  await expect(page.locator("[data-toast]").filter({ hasText: "Answer sent" })).toHaveCount(1);
});

test("an answer the harness holds says it waits for the turn to end until the turn moves on", async ({ page }) => {
  await expandNeedsYou(page);
  await needRow(page, /CA-407/).click();
  const pane = needsPane(page);
  await expect(pane).toContainText("Your answer reaches the agent when its current turn ends.");
  await pane.getByRole("textbox", { name: "Your answer" }).fill("Yes, keep 10% back.");
  await pane.getByRole("button", { name: "Send answer" }).click();
  await expectToast(page, "Answer sent. The agent gets it when its current turn ends.");
  await expect(card(page, "CA-407")).toContainText("Your answer waits for the turn to end");
  await advanceRuns(page, 1, (await runOf(page, "CA-407")).id);
  await expect(card(page, "CA-407")).not.toContainText("Your answer waits for the turn to end");
});

test("the sheet's Answer sent line says the agent gets the answer when its turn ends", async ({ page }) => {
  const sheet = await sheetOf(page, "CA-407");
  await sheet.getByRole("textbox", { name: "Your answer" }).fill("No control group.");
  await sheet.getByRole("button", { name: "Send answer" }).click();
  await expect(sheet.locator("[data-answer-sent]")).toHaveText("Answer sent. The agent gets it when its current turn ends.");
});

test("a session the harness couldn't open says why and offers Retry launch, and an answer waiting on a stopped session says so", async ({ page }) => {
  await expect(card(page, "CA-406")).toContainText("The harness couldn't start the agent: the session limit is reached");
  await expect(card(page, "SUP-10")).toContainText("Your answer waits for the session to resume");
  const sheet = await sheetOf(page, "CA-406");
  await expect(sheet).toContainText("It didn't start");
  await sheet.getByRole("button", { name: "Retry launch" }).click();
  await expect.poll(async () => (await runOf(page, "CA-406")).state).toBe("queued");
});
