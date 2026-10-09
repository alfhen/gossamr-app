import { expect, test, type Page } from "@playwright/test";
import { askPip, openApp, openPip, PIP_INPUT, pipPane } from "./support/app";

/** Where the sample backend keeps Pip's turns (KEY in src/backend/mockPipTurns.ts). */
const STORE = "gossamr-mock-pip-turns";
const QUESTION = "What am I looking at?";
const ANSWER = "Ask me to show stale or blocked tickets";

interface Kept {
  requestId: string;
  prompt: string;
  status: string;
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

const kept = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as Kept[], STORE);

/** Opens Pip unless the page kept it open across the reload. */
async function showPip(page: Page) {
  if (!(await pipPane(page).isVisible())) await openPip(page);
}

/** Asks Pip and waits until the answer is in and the turn is over. */
async function askAndWait(page: Page, question: string, answer: string) {
  await askPip(page, question);
  await expect(pipPane(page).getByText(answer).last()).toBeVisible();
  await expect(pipPane(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openPip(page);
});

test("a finished conversation is shown again after a reload", async ({ page }) => {
  await askAndWait(page, QUESTION, ANSWER);
  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await showPip(page);
  await expect(pipPane(page).getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(pipPane(page).getByText(ANSWER)).toBeVisible();
});

test("the conversation survives a restart and a follow-up continues it", async ({ page, context }) => {
  await askAndWait(page, QUESTION, ANSWER);
  const first = (await kept(page)).find((t) => t.prompt === QUESTION);
  expect(first?.sessionId).toBeTruthy();

  await page.close();
  const again = await context.newPage();
  await openApp(again);
  await showPip(again);
  await expect(pipPane(again).getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(pipPane(again).getByText(ANSWER)).toBeVisible();

  await askAndWait(again, "Show me the blocked tickets", "Blocked tickets. I filtered this view");
  const turns = await kept(again);
  expect(turns.map((t) => t.prompt)).toEqual([QUESTION, "Show me the blocked tickets"]);
  expect(turns[1].sessionId).toBe(first?.sessionId);
  await expect(pipPane(again).getByText(QUESTION, { exact: true })).toBeVisible();
});

test("each turn's usage is recorded in the store", async ({ page }) => {
  await askAndWait(page, QUESTION, ANSWER);
  const turn = (await kept(page)).find((t) => t.prompt === QUESTION);
  expect(turn?.status).toBe("done");
  expect(turn?.requestId).toBeTruthy();
  expect(turn?.usage?.inputTokens).toBeGreaterThan(0);
  expect(turn?.usage?.outputTokens).toBeGreaterThan(0);
  expect(turn?.usage?.costUsd).toBeGreaterThan(0);
});

test("a reload mid-answer doesn't stop Pip: the turn carries on and ends as answered", async ({ page }) => {
  // Reloading the page leaves the app running in Tauri, so the answer goes on; slowed so the reload lands mid-answer.
  await openApp(page, "pipPace=150");
  await showPip(page);
  await askPip(page, QUESTION);
  const pane = pipPane(page);
  await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.reload();

  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await showPip(page);
  await expect(pane.getByText(QUESTION, { exact: true })).toHaveCount(1);
  await expect(pane.getByText(ANSWER)).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(pane.getByRole("alert")).toHaveCount(0);
  expect((await kept(page)).map((t) => [t.prompt, t.status])).toEqual([[QUESTION, "done"]]);
  await expect(page.locator(PIP_INPUT)).toBeEnabled();
});

test("a restart cuts off the running turn and the queued one, each said its own way", async ({ page, context }) => {
  test.setTimeout(60_000);
  await openApp(page, "pipPace=200");
  await showPip(page);
  await askPip(page, QUESTION);
  await askPip(page, "Show me the blocked tickets");
  await expect(pipPane(page).getByText("Queued, runs after the current answer")).toBeVisible();

  // A new tab starts the sample app afresh, as quitting and opening the app does.
  await page.close();
  const again = await context.newPage();
  await openApp(again, "pipPace=200");
  await showPip(again);
  const pane = pipPane(again);
  await expect(pane.getByRole("alert")).toHaveText(["Gossamr closed before Pip finished", "Gossamr closed before this question ran"]);
  await expect(pane.getByText(/^Looking at/)).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
  expect((await kept(again)).map((t) => t.status)).toEqual(["failed", "failed"]);
  await expect(again.locator(PIP_INPUT)).toBeEnabled();
});

test("the draft a turn made is still under it after a reload, once, even when the reload came mid-answer", async ({ page }) => {
  await openApp(page, "pipPace=150");
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await showPip(page);
  const pane = pipPane(page);
  const comment = pane.getByRole("article", { name: "Comment on CA-401" });
  await askPip(page, "Draft a comment");
  await expect(comment).toHaveCount(1);
  await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.reload();

  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await showPip(page);
  await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 20_000 });
  await expect(pane.getByText("It isn't posted; approve, edit or skip it below.")).toBeVisible();
  await expect(comment).toHaveCount(1);

  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await showPip(page);
  await expect(pane.getByText("Draft a comment", { exact: true })).toBeVisible();
  await expect(comment).toHaveCount(1);
  // It is the turn's draft, under its answer, not one left over from before.
  await expect(pane.getByRole("region", { name: "Drafts" }).getByRole("article", { name: "Comment on CA-401" })).toHaveCount(0);
});
