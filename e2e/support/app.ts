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

/** What the sample backend's handle offers the tests (MockHandle in src/backend/mockWatch.ts). */
type Script = { planRecommended?: boolean; verdict?: "pass" | "blocking"; marker?: boolean };
interface Handle {
  runs(): { id: string; kind: string; state: string }[];
  workstreamEvents(): { workstreamId: string; actor: string; action: string; runId: string | null; detail?: string | null }[];
  scriptNext(kind: string, script: Script): void;
  jiraWrites(): { proposalId: string; type: string; key: string | null }[];
  setBudget(id: string, budget: { autoTurns?: number | null; wakes?: number | null }): void;
  holdPip(on: boolean): void;
}
type Mocked = { __gossamrMock?: Handle };
const NO_MOCK = "the sample backend isn't there; is this a dev build in mock mode?";

/** Every run the sample backend holds, newest first. */
export const mockRuns = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.runs();
  }, NO_MOCK);

/** The audit of every workstream, oldest first within each. */
export const workstreamEvents = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.workstreamEvents();
  }, NO_MOCK);

/** The next run of `kind` to finish writes what `script` says: a triage's plan recommendation, a review's verdict, a data marker. */
export const scriptNextRun = (page: Page, kind: string, script: Script) =>
  page.evaluate(
    ({ kind, script, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.scriptNext(kind, script);
    },
    { kind, script, missing: NO_MOCK },
  );

/** Every write the sample tracker made, with the draft the person approved for it. */
export const jiraWrites = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.jiraWrites();
  }, NO_MOCK);

/** Sets workstream `id`'s own limits for automatic turns and wakes. */
export const setBudget = (page: Page, id: string, budget: { autoTurns?: number | null; wakes?: number | null }) =>
  page.evaluate(
    ({ id, budget, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.setBudget(id, budget);
    },
    { id, budget, missing: NO_MOCK },
  );

/** Makes the scripted Pip wait, still answering, after it starts each turn (`on`), or lets it go on: a turn to act on while it runs. */
export const holdPip = (page: Page, on: boolean) =>
  page.evaluate(
    ({ on, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.holdPip(on);
    },
    { on, missing: NO_MOCK },
  );

/** The Manage switch of the workstream the Pip pane shows. */
export const manageSwitch = (page: Page) => pipPane(page).getByRole("switch", { name: "Manage this workstream" });

/** Turns Manage on (or off) for the workstream the Pip pane shows, as the person does with its switch. */
export async function setManage(page: Page, on = true) {
  const control = manageSwitch(page);
  if ((await control.getAttribute("aria-checked")) !== String(on)) await control.click();
  await expect(control).toHaveAttribute("aria-checked", String(on));
}

/** Pip's wake turns in the pane, the ones nobody asked; `wakeTurns` counts them. */
export const wakes = (page: Page) => pipPane(page).locator('[data-turn-kind="wake"]');
export const wakeTurns = (page: Page) => wakes(page).count();

/** The banner saying why the pane's workstream is held, with its Resume. */
export const heldBanner = (page: Page) => pipPane(page).locator("[data-held-banner]");

/** Presses Hold all: the rail's button, or Cmd/Ctrl+Shift+Period. */
export async function holdAll(page: Page, by: "button" | "shortcut" = "button") {
  if (by === "button") await page.getByRole("button", { name: "Hold all workstreams" }).click();
  else await page.keyboard.press("ControlOrMeta+Shift+Period");
}
