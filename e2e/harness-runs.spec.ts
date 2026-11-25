import { expect, type Page, test } from "@playwright/test";
import { advanceRuns, agentsHome, expandNeedsYou, expectToast, mockRuns, needRow, needsPane, openAgents, openApp, openRunOf, pipPane, runSheet } from "./support/app";

/** Said when an answer goes to a run handed over to Terminal; `HANDED_OVER_ASK` in src/types.ts. */
const HANDED_OVER = "It was handed over to Terminal. Say whether you took it back there before Gossamr resumes it.";

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

test("a run whose commit the signing agent refused says so, offers no Retry, and asks Pip to start it again", async ({ page }) => {
  await expect(card(page, "CA-430")).toContainText("Your signing agent refused a commit, so the agent stopped.");
  const sheet = await sheetOf(page, "CA-430");
  await expect(sheet).toContainText("The run stopped without finishing");
  await expect(sheet).toContainText("Unlock it or check its settings, then ask Pip to start the agent again.");
  await expect(sheet.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Ask Pip to start it again" }).click();
  await expect(pipPane(page).getByText("Ask Pip to start it again").last()).toBeVisible();
});

test("an interrupted agent's Clean up asks first, Keep it and Esc leave it, and Yes removes the worktree", async ({ page }) => {
  await expect(card(page, "WEB-131")).toContainText("Gossamr stopped this agent when it updated how agents run.");
  const sheet = await sheetOf(page, "WEB-131");
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

test("a clean-up Gossamr refuses shows its reason in its own words and removes nothing", async ({ page }) => {
  const sheet = await sheetOf(page, "DEVOPS-490");
  await expect(sheet).toContainText("Gossamr refuses while work in it isn't pushed");
  await sheet.getByRole("button", { name: "Clean up", exact: true }).click();
  await sheet.getByRole("group", { name: "Clean up this run" }).getByRole("button", { name: "Yes, remove it" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Gossamr kept it: The worktree has unpushed commits. Push them or discard them yourself, then try again.");
  await expect(sheet).not.toContainText("The worktree and its branch were removed.");
});

test("a run handed over to Terminal says why in Needs you and sends the answer only on I took it back", async ({ page }) => {
  await expandNeedsYou(page);
  await needRow(page, /SUP-21/).click();
  const pane = needsPane(page);
  await expect(pane.getByRole("status").filter({ hasText: HANDED_OVER })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Send answer" })).toHaveCount(0);
  const box = pane.getByRole("textbox", { name: "Your answer" });
  // Plain keys are the person's text here, and ⌘↵ doesn't send for a run handed over.
  await box.fill("");
  await box.pressSequentially("jk yes");
  await expect(box).toHaveValue("jk yes");
  await expect(pane).toContainText("SUP-21");
  await box.press("ControlOrMeta+Enter");
  expect((await runOf(page, "SUP-21")).state).toBe("needsAnswer");
  await pane.getByRole("button", { name: "I took it back" }).click();
  await expect(needRow(page, /SUP-21/)).toHaveCount(0);
  expect((await runOf(page, "SUP-21")).state).toBe("working");
});

test("an answer the harness holds says it waits for the turn to end until the turn moves on", async ({ page }) => {
  await expandNeedsYou(page);
  await needRow(page, /CA-432/).click();
  const pane = needsPane(page);
  await expect(pane).toContainText("Your answer reaches the agent when its current turn ends.");
  await pane.getByRole("textbox", { name: "Your answer" }).fill("They vanish.");
  await pane.getByRole("button", { name: "Send answer" }).click();
  await expectToast(page, "Answer sent. The agent gets it when its current turn ends.");
  await expect(card(page, "CA-432")).toContainText("Your answer waits for the turn to end.");
  await advanceRuns(page, 1, (await runOf(page, "CA-432")).id);
  await expect(card(page, "CA-432")).not.toContainText("Your answer waits for the turn to end.");
});
