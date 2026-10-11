import { expect, type Page } from "@playwright/test";

/** The id of Pip's message input (PIP_INPUT_ID in src/workspace/PipPane.tsx). */
export const PIP_INPUT = "#pip-input";

/**
 * Opens the workspace in mock mode and waits for the sample tickets. `query` goes through as the page's search string, so mock
 * flags such as `runs=empty` reach mockOptionsFromUrl.
 */
export async function openApp(page: Page, query = "") {
  await page.goto(query ? `/?${query.replace(/^\?/, "")}` : "/");
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
}

/** The Pip pane. */
export const pipPane = (page: Page) => page.locator('aside[aria-label="Pip"]');

/** Opens Pip with Cmd/Ctrl+J and waits for its pane. */
export async function openPip(page: Page) {
  await page.keyboard.press("ControlOrMeta+j");
  await expect(pipPane(page)).toBeVisible();
}

/** Types `text` into Pip's input and sends it. */
export async function askPip(page: Page, text: string) {
  const input = page.locator(PIP_INPUT);
  await input.fill(text);
  await input.press("Enter");
}

/** The peek sheet. */
export const peekSheet = (page: Page) => page.locator("#peek-sheet");

/** The line at the head of the Pip pane naming its conversation: "General", or "Workstream: <title> · <Stage>". */
export const pipConversation = (page: Page) => pipPane(page).locator("[data-pip-conversation]");

/** Opens the peek of `key` from the canvas's item list. */
export async function peekTicket(page: Page, key: string) {
  await page.getByRole("listbox", { name: "Items" }).getByText(key, { exact: true }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", `Details for ${key}`);
}

/**
 * Peeks `key` and presses 'Start a workstream' there, then waits for the Pip pane to show the workstream's own
 * conversation, still at intake.
 */
export async function startWorkstream(page: Page, key: string) {
  await peekTicket(page, key);
  await peekSheet(page).getByRole("button", { name: "Start a workstream" }).click();
  await expect(pipConversation(page)).toHaveText(new RegExp(`^Workstream: ${key} .* · Intake$`));
}

/** Closes the one-time Agents safety sheet if a fresh profile's first agent action showed it. */
export async function dismissAgentSafety(page: Page) {
  const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
  if (await safety.isVisible()) await safety.getByRole("button", { name: "Close" }).click();
  await expect(safety).toHaveCount(0);
}

/**
 * Steps the sample backend's scripted runs along `times` times (queued, launching, working, done): every unfinished run,
 * or only run `id`. It goes through `__gossamrMock`, which the sample backend sets in a dev browser (exposeMockClock in
 * src/backend/mockWatch.ts).
 */
export async function advanceRuns(page: Page, times = 1, id?: string) {
  for (let i = 0; i < times; i++) {
    await page.evaluate((run) => {
      const mock = (globalThis as { __gossamrMock?: { advanceRuns(id?: string): void } }).__gossamrMock;
      if (!mock) throw new Error("the sample backend's clock isn't there; is this a dev build in mock mode?");
      mock.advanceRuns(run ?? undefined);
    }, id ?? null);
  }
}

/**
 * Makes the sample code host show the draft pull requests finished builds opened, as a code sync finding them, rather than
 * after a moment (or never, with `prSurface=manual`). Through `__gossamrMock.surfacePullRequests` (src/backend/mockWatch.ts).
 */
export async function surfacePullRequests(page: Page) {
  return page.evaluate(() => {
    const mock = (globalThis as { __gossamrMock?: { surfacePullRequests(): boolean } }).__gossamrMock;
    if (!mock) throw new Error("the sample backend isn't there; is this a dev build in mock mode?");
    return mock.surfacePullRequests();
  });
}
