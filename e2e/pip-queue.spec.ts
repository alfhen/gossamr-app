import { expect, test, type Page } from "@playwright/test";
import { askPip, openApp, openPip, pipPane } from "./support/app";

/** Where the sample backend keeps Pip's turns (KEY in src/backend/mockPipTurns.ts). */
const STORE = "gossamr-mock-pip-turns";
const FIRST = "What am I looking at?";
const FIRST_ANSWER = "Ask me to show stale or blocked tickets";
const SECOND = "Show me the blocked tickets";
const SECOND_ANSWER = "I filtered this view for you";
const QUEUED = "Queued, runs after the current answer";

interface Kept {
  requestId: string;
  prompt: string;
  status: string;
  error: string | null;
  sessionId: string | null;
}

const kept = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as Kept[], STORE);

/** Where `text` first appears in the pane's text, so the order of answers can be compared. */
async function offset(page: Page, text: string) {
  const all = await pipPane(page).innerText();
  return all.indexOf(text);
}

// Slow enough that the second question is sent while the first is still being answered.
test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page, "pipPace=200");
  await openPip(page);
});

test("a second question waits its turn and is answered after the first, and both come back after a reload", async ({ page }) => {
  const pane = pipPane(page);
  await askPip(page, FIRST);
  await askPip(page, SECOND);

  await expect(pane.getByText(QUEUED)).toBeVisible();
  await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(pane.getByText(SECOND_ANSWER)).toHaveCount(0);

  await expect(pane.getByText(FIRST_ANSWER)).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByText(QUEUED)).toHaveCount(0, { timeout: 5_000 });
  await expect(pane.getByText(SECOND_ANSWER)).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);

  expect(await offset(page, FIRST_ANSWER)).toBeLessThan(await offset(page, SECOND));
  expect(await offset(page, SECOND)).toBeLessThan(await offset(page, SECOND_ANSWER));
  const turns = await kept(page);
  expect(turns.map((t) => [t.prompt, t.status])).toEqual([
    [FIRST, "done"],
    [SECOND, "done"],
  ]);
  expect(turns[1].sessionId).toBe(turns[0].sessionId);

  await page.reload();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  if (!(await pipPane(page).isVisible())) await openPip(page);
  await expect(pane.getByText(FIRST, { exact: true })).toBeVisible();
  await expect(pane.getByText(SECOND, { exact: true })).toBeVisible();
  await expect(pane.getByText(SECOND_ANSWER)).toBeVisible();
  expect(await offset(page, FIRST)).toBeLessThan(await offset(page, FIRST_ANSWER));
  expect(await offset(page, FIRST_ANSWER)).toBeLessThan(await offset(page, SECOND));
  expect(await offset(page, SECOND)).toBeLessThan(await offset(page, SECOND_ANSWER));
  await expect(pane.getByText(QUEUED)).toHaveCount(0);
});

test("Stop ends only the answer in progress, and the queued question then runs to the end", async ({ page }) => {
  const pane = pipPane(page);
  await askPip(page, FIRST);
  await askPip(page, SECOND);
  await expect(pane.getByText(QUEUED)).toBeVisible();

  await pane.getByRole("button", { name: "Stop" }).click();
  await expect(pane.getByRole("alert")).toHaveText("Stopped");
  await expect(pane.getByText(QUEUED)).toHaveCount(0);
  await expect(pane.getByText(SECOND_ANSWER)).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(pane.getByRole("alert")).toHaveCount(1);
  expect((await kept(page)).map((t) => [t.prompt, t.status])).toEqual([
    [FIRST, "failed"],
    [SECOND, "done"],
  ]);
});

test("Remove takes a queued question out before it runs", async ({ page }) => {
  const pane = pipPane(page);
  await askPip(page, FIRST);
  await askPip(page, SECOND);
  await expect(pane.getByText(QUEUED)).toBeVisible();

  await pane.getByRole("button", { name: "Remove this question" }).click();
  await expect(pane.getByText(QUEUED)).toHaveCount(0);
  await expect(pane.getByText("Removed before it started")).toBeVisible();
  await expect(pane.getByRole("button", { name: "Stop" })).toBeVisible();

  await expect(pane.getByText(FIRST_ANSWER)).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
  // The queue starts the next turn in the same step that ends the first, so once the first is stored as done, a second
  // that was still queued would be running by now.
  await expect.poll(async () => (await kept(page)).find((t) => t.prompt === FIRST)?.status).toBe("done");
  expect((await kept(page)).find((t) => t.prompt === SECOND)?.status).toBe("failed");
  await expect(pane.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(pane.getByText(SECOND_ANSWER)).toHaveCount(0);
  await expect(pane.getByText("Searched the items")).toHaveCount(0);
  const second = (await kept(page)).find((t) => t.prompt === SECOND);
  expect([second?.status, second?.error]).toEqual(["failed", "Removed before it started"]);
});
