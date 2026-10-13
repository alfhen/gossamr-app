import { expect, type Locator, type Page } from "@playwright/test";

/** The id of Pip's message input (PIP_INPUT_ID in src/workspace/PipPane.tsx). */
export const PIP_INPUT = "#pip-input";

/** Where the app's preferences are kept (KEY in src/workspace/prefs.ts). */
const PREFS = "gossamr-prefs";

/**
 * Makes this page's profile one whose person turned 'Start on Pip home' off, so a load lands on the workspace with Agents
 * on too. Only a profile that hasn't chosen yet is changed, and its other preferences stay (the config seeds the
 * orientation card dismissed): whatever the app or the test saves afterwards stands, across reloads as well.
 */
export async function landOnWorkspace(page: Page) {
  await page.addInitScript((key) => {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
    } catch {
      // Unreadable preferences are the app's to reset.
    }
    if (prefs.startOnPipHome === undefined) localStorage.setItem(key, JSON.stringify({ ...prefs, startOnPipHome: false }));
  }, PREFS);
}

/**
 * Opens the workspace in mock mode and waits for the sample tickets. `query` goes through as the page's search string, so mock
 * flags such as `runs=empty` reach mockOptionsFromUrl. Pip home is where the app lands with Agents on; the specs here start
 * on the workspace, as a person who turned that off does (`landOnWorkspace`), and go to Pip home when they mean to.
 */
export async function openApp(page: Page, query = "") {
  await landOnWorkspace(page);
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
type Script = { planRecommended?: boolean; ready?: boolean; questions?: string[]; verdict?: "pass" | "blocking"; marker?: boolean };
/** The restriction a read-only run is launched with (`ReadOnly` in src/types.ts). */
export type ReadOnly = { mode: string; allow: string[]; deny: string[]; guard: string };
/** One launch as the mock launcher made it (`MockLaunch` in src/backend/mockRuns.ts). */
export type MockLaunch = { runId: string; kind: string; readOnly: ReadOnly | null; guard: string; autoStart: string | null; at: string };
interface Handle {
  runs(): { id: string; kind: string; state: string; prSha: string | null; passes: number; key: string | null; shortId: string | null; digest: string; name: string }[];
  launches(): MockLaunch[];
  workstreamEvents(): { workstreamId: string; actor: string; action: string; runId: string | null; detail?: string | null }[];
  scriptNext(kind: string, script: Script): void;
  askRun(id: string, question: string): void;
  askPermission(id: string, needs: string): void;
  blockRun(id: string): void;
  loseRun(id: string): void;
  stopRunAtLimit(id: string): void;
  attached(): string[];
  jiraWrites(): { proposalId: string; type: string; key: string | null }[];
  reviewDrafts(): ReviewDraftRow[];
  setBudget(id: string, budget: { autoTurns?: number | null; wakes?: number | null }): void;
  seedWorkstreamEvent(key: string, event: { actor: string; action: string; at: string; runId?: string | null; proposalId?: string | null; detail?: string | null }): void;
  backdateWorkstream(key: string, days: number): void;
  holdWorkstream(key: string, reason: string): void;
  holdPip(on: boolean): void;
  pipIdle(): boolean;
  editTicket(key: string, change: TicketEdit): void;
  githubWrites(): GithubWrite[];
  movePullHead(repo: string, number: number): boolean;
  githubPostsTried(): number;
  loseNextReviewAnswer(kept: boolean): void;
}
/** A GitHub review draft as the sample backend holds it (`MockReviewDraft` in src/backend/mockWatch.ts); `pull` is "repo#number". */
export type ReviewDraftRow = { id: string; runId: string; pull: string; state: string; supersededBy: string | null; edited: boolean };
/** One review posted to the sample GitHub (`GithubWrite` in src/backend/mockGithub.ts). */
export type GithubWrite = {
  proposalId: string;
  repo: string;
  number: number;
  event: "COMMENT";
  commitId: string;
  body: string;
  comments: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[];
};
/** What `editTicket` changes on a sample ticket; the status is a status id or its name. */
type TicketEdit = { summary?: string; description?: string; statusId?: string };
type Mocked = { __gossamrMock?: Handle };
const NO_MOCK = "the sample backend isn't there; is this a dev build in mock mode?";

/** Every run the sample backend holds, newest first. */
export const mockRuns = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.runs();
  }, NO_MOCK);

/** Every launch the sample backend made, oldest first, with the read-only restriction it would pass Claude Code. */
export const mockLaunches = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.launches();
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

/** Has working run `id` ask the person `question`, as a run stopping to ask does (`MockRuns.ask`). */
export const askRun = (page: Page, id: string, question: string) =>
  page.evaluate(
    ({ id, question, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.askRun(id, question);
    },
    { id, question, missing: NO_MOCK },
  );

/** Has working run `id` ask permission for `needs`, worded as the listing has it (`approve Bash: git push`), as `MockRuns.askPermission`. */
export const askPermission = (page: Page, id: string, needs: string) =>
  page.evaluate(
    ({ id, needs, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.askPermission(id, needs);
    },
    { id, needs, missing: NO_MOCK },
  );

/** Has working run `id` be blocked on Claude's sign-in, as a run is when Claude reports it (`MockRuns.block`). */
export const blockRun = (page: Page, id: string) =>
  page.evaluate(
    ({ id, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.blockRun(id);
    },
    { id, missing: NO_MOCK },
  );

/** Has run `id` go unclear, as a run does when Claude reports a state Gossamr can't read (`MockRuns.lose`). */
export const loseRun = (page: Page, id: string) =>
  page.evaluate(
    ({ id, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.loseRun(id);
    },
    { id, missing: NO_MOCK },
  );

/** Has Gossamr stop run `id` at its limit, as it does a run that passes its time limit (`MockRuns.stopAtLimit`). */
export const stopRunAtLimit = (page: Page, id: string) =>
  page.evaluate(
    ({ id, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.stopRunAtLimit(id);
    },
    { id, missing: NO_MOCK },
  );

/** The run ids Terminal was opened on, oldest first. */
export const mockAttached = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.attached();
  }, NO_MOCK);

/** Every write the sample tracker made, with the draft the person approved for it. */
export const jiraWrites = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.jiraWrites();
  }, NO_MOCK);

/** Every GitHub review draft, newest first, with its state and what replaced it. */
export const reviewDrafts = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.reviewDrafts();
  }, NO_MOCK);

/** The GitHub review drafts still waiting for the person, newest first. */
export const pendingReviewDrafts = async (page: Page) => (await reviewDrafts(page)).filter((d) => d.state === "pending");

/** Every review posted to the sample GitHub, oldest first, with the draft the person approved for it: the only GitHub writes there are. */
export const githubWrites = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.githubWrites();
  }, NO_MOCK);

/** Someone pushes to pull request `number` of `repo`: its head moves to a new commit whose diff lacks the lines it showed. */
export const movePullHead = (page: Page, repo: string, number: number) =>
  page.evaluate(
    ({ repo, number, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      return mock.movePullHead(repo, number);
    },
    { repo, number, missing: NO_MOCK },
  );

/** How many reviews the sample GitHub was asked to post, refused ones included. */
export const githubPostsTried = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.githubPostsTried();
  }, NO_MOCK);

/** The next review post's answer is lost, as a 502: the sample GitHub keeps the review when `kept`, and drops it otherwise. */
export const loseNextReviewAnswer = (page: Page, kept: boolean) =>
  page.evaluate(
    ({ kept, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.loseNextReviewAnswer(kept);
    },
    { kept, missing: NO_MOCK },
  );

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

/**
 * Adds an audit line to the open workstream on ticket `key` as of `at` (an ISO time), the way to age what depends on the time
 * since: the sample backend's clock is the browser's, which a test can't move.
 */
export const seedWorkstreamEvent = (page: Page, key: string, event: { actor: string; action: string; at: string; runId?: string | null; proposalId?: string | null; detail?: string | null }) =>
  page.evaluate(
    ({ key, event, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.seedWorkstreamEvent(key, event);
    },
    { key, event, missing: NO_MOCK },
  );

/** Makes the open workstream on ticket `key` `days` days older: it opened that much earlier. */
export const backdateWorkstream = (page: Page, key: string, days: number) =>
  page.evaluate(
    ({ key, days, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.backdateWorkstream(key, days);
    },
    { key, days, missing: NO_MOCK },
  );

/** Changes sample ticket `key` as someone editing it in Jira would: its summary, description or status (an id or a name). */
export const editTicket = (page: Page, key: string, change: TicketEdit) =>
  page.evaluate(
    ({ key, change, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.editTicket(key, change);
    },
    { key, change, missing: NO_MOCK },
  );

/** Holds the open workstream on ticket `key` as the system would, for `reason` ("restart", "budget", "daily_cap", ...): the holds that are a need, unlike the person's own Hold. */
export const holdBySystem = (page: Page, key: string, reason: string) =>
  page.evaluate(
    ({ key, reason, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.holdWorkstream(key, reason);
    },
    { key, reason, missing: NO_MOCK },
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
  else {
    // From outside any field, as the shortcut does nothing while the person types.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("ControlOrMeta+Shift+Period");
  }
}

/** Pip home (src/workspace/PipHome.tsx): the workstreams, the conversation and the steps. */
export const pipHome = (page: Page) => page.locator("[data-pip-home]");

/** Opens Pip home with Cmd/Ctrl+0 and waits for its workstream list. */
export async function openPipHome(page: Page) {
  await page.keyboard.press("ControlOrMeta+0");
  await expect(pipHome(page).getByRole("navigation", { name: "Workstreams" })).toBeVisible();
}

/** The line at the head of Pip home's conversation naming it: "General", or "Workstream: <title> · <Stage>". */
export const homeConversation = (page: Page) => pipHome(page).getByRole("region", { name: "Conversation" }).locator("[data-pip-conversation]");

/**
 * The peek over Pip home sits in the window as it opened: nothing around it scrolled (a card focused in it once scrolled
 * the app's root, pushing the title bar, the conversation's header and the peek's own Close out of the top of the window
 * and leaving a blank band at the bottom), its Close and the conversation's header on screen.
 */
export async function expectPeekInPlace(page: Page) {
  const scrolled = await peekSheet(page).evaluate((peek) => {
    const out: string[] = [];
    for (let el = peek.parentElement; el; el = el.parentElement) if (el.scrollTop || el.scrollLeft) out.push(`${el.tagName}.${el.className}`);
    const doc = document.scrollingElement;
    if (doc && (doc.scrollTop || doc.scrollLeft)) out.push("document");
    return out;
  });
  expect(scrolled, "nothing outside the peek is scrolled").toEqual([]);
  await expect(peekSheet(page).getByRole("button", { name: "Close details" })).toBeInViewport({ ratio: 1 });
  await expect(homeConversation(page)).toBeInViewport({ ratio: 1 });
}

/** Pip home's composer input, the only Pip input on screen there. */
export const homeComposer = (page: Page) => pipHome(page).locator(PIP_INPUT);

/** The cobweb on a workstream's row in Pip home's list: its drawing and its words for a screen reader (`data-workstream-wither`). */
export const workstreamWeb = (page: Page, key: string) => workstreamRow(page, key).locator("svg.cobweb");
export const workstreamWebText = (page: Page, key: string) => workstreamRow(page, key).locator("[data-workstream-wither]");

/** The row of the open workstream on ticket `key` in Pip home's list; `workstreamRow(page, "General")` is General's. */
export const workstreamRow = (page: Page, key: string) =>
  pipHome(page)
    .getByRole("listbox", { name: "Workstreams" })
    .getByRole("option", { name: key === "General" ? /^General/ : new RegExp(`^${key}\\b`) });

/** Pip home's Needs you list: the main left column, with the workstream list under it. */
export const needsYouTray = (page: Page) => pipHome(page).getByRole("region", { name: "Needs you" });

/** The Needs you list's one count, as its pill says it. */
export const needsYouCount = (page: Page) => needsYouTray(page).locator("[data-needs-you-count]");

/** The row of the workstream on ticket `key` in the Needs you list, or General's (`key` "General"). */
export const needsYouRow = (page: Page, key: string) =>
  key === "General" ? needsYouTray(page).locator('[data-needs-you-row="general"]') : needsYouTray(page).locator("[data-needs-you-row]").filter({ has: page.locator("[data-needs-you-key]", { hasText: key }) });

/** A need's own row in the Needs you list, by the words it reads; its group has to be expanded first (`expandNeedsYou`). */
export const needRow = (page: Page, name: string | RegExp) => needsYouTray(page).locator("[data-needs-you-need]").filter({ hasText: name });

/**
 * The Needs you row whose need is of `kind` ("permission", "question", "failure", "escalation", "hold", "draft", ...): a
 * group's row when it leads the group, else its own row once the group is expanded (`expandAllNeeds`). The first, when
 * both show it.
 */
export const needOfKind = (page: Page, kind: string) =>
  needsYouTray(page)
    .locator(`[data-needs-you-group][data-kind="${kind}"], [data-needs-you-need][data-kind="${kind}"]`)
    .first();

/** Expands every group in the Needs you list, so each need in it is a row of its own. */
export async function expandAllNeeds(page: Page) {
  const folded = needsYouTray(page).locator('[data-needs-you-more][aria-expanded="false"]');
  while (await folded.count()) await folded.first().click();
}

/** Folds every group in the Needs you list to its header: its top need's why, and "+N more". Pip home opens a group by default while the needs fit. */
export async function foldAllNeeds(page: Page) {
  const open = needsYouTray(page).locator('[data-needs-you-more][aria-expanded="true"]');
  while (await open.count()) await open.first().click();
}

/** Expands the group of workstream `key` (or General) in the Needs you list, so each need in it is a row of its own. */
export async function expandNeedsYou(page: Page, key = "General") {
  const more = needsYouRow(page, key).locator("[data-needs-you-more]");
  // Pip home opens a group by itself while the needs fit, and folds it again once more arrive; opened by hand it stays.
  if ((await more.getAttribute("aria-expanded")) === "true") {
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "false");
  }
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
}

/** The decision open in Pip home's middle column. */
export const needsPane = (page: Page) => pipHome(page).getByRole("region", { name: "Decision" });

/** Pip home's conversation column, where its cards are. */
export const homeConversationRegion = (page: Page) => pipHome(page).getByRole("region", { name: "Conversation" });

/** Pip home's step rail, the Steps column. */
export const stepRail = (page: Page) => pipHome(page).getByRole("complementary", { name: "Steps" });

/** The chip of step `kind` (investigate, triage, plan, build, review, verify) on Pip home's step rail, with what it opens to. */
export const stepChip = (page: Page, kind: string) => stepRail(page).locator(`[data-step="${kind}"]`);

/** Waits until the sample backend has said whether Agents are on: the rail's Agents button shows or goes. */
export async function agentsSettled(page: Page, on = true) {
  await expect(page.getByRole("button", { name: /^Agents/ })).toHaveCount(on ? 1 : 0);
}

/** Whether the scripted Pip has no turn running or waiting anywhere, a wake the supervisor queued included. */
export const pipIdle = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.pipIdle();
  }, NO_MOCK);

/**
 * Waits until Pip has finished answering on Pip home: the sample Pip has nothing running or waiting, a wake a run's
 * finish queued included, and the conversation shows every turn ended. No Stop on screen alone proves nothing until a
 * turn has started.
 */
export async function homeSettled(page: Page) {
  await expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);
  await expect(homeConversationRegion(page).locator('[data-turn-status="running"], [data-turn-status="queued"]')).toHaveCount(0);
  await expect(pipHome(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

/**
 * Waits until Pip has finished answering in the workspace's Pip pane: the sample Pip has nothing running or waiting
 * anywhere, a wake a run's finish queued included, and the pane shows every turn ended. The Stop button alone is not
 * the condition: it is gone between turns that follow one another, and it stays while a wake that a person's message
 * set aside is answered again behind that message, which takes a turn after a turn.
 */
export async function paneSettled(page: Page) {
  await expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);
  await expect(pipPane(page).locator('[data-turn-status="running"], [data-turn-status="queued"]')).toHaveCount(0);
  await expect(pipPane(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

/** Pip's wake turns in Pip home's conversation, the ones nobody asked. */
export const homeWakes = (page: Page) => pipHome(page).getByRole("region", { name: "Conversation" }).locator('[data-turn-kind="wake"]');

/**
 * Moves run `id` on to done (queued, launching, working, done) once Pip has answered, then waits for the wake turn its
 * finish brings to arrive and be answered: no Stop on screen proves nothing until that turn has started.
 */
export async function finishOnHome(page: Page, id: string) {
  await homeSettled(page);
  const before = await homeWakes(page).count();
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
  await expect.poll(() => homeWakes(page).count(), { message: `Pip is woken for run ${id}` }).toBeGreaterThan(before);
  await homeSettled(page);
}

/** Pip's run drafts on ticket `key` in Pip home's conversation, oldest first. */
export const homeRunCards = (page: Page, key: string) => homeConversationRegion(page).getByRole("article", { name: `Start an agent: ${key}` });

/**
 * Opens the 'Review and start' of run draft `card` in place on Pip home, past the safety sheet a fresh profile shows once
 * at its first agent action, and returns the review as shown. `by: "keyboard"` presses Enter on the card instead of
 * clicking its button; the card must have keyboard focus then, and `refocus` brings it back after the safety sheet.
 */
export async function inlineStart(page: Page, card: Locator, by: "click" | "keyboard" = "click", refocus: () => Promise<void> = () => card.focus()) {
  const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
  const review = card.getByRole("group", { name: "Review and start" });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (by === "click") await card.getByRole("button", { name: "Review and start", exact: true }).click();
    else await page.keyboard.press("Enter");
    await expect(review.or(safety)).toBeVisible();
    if (!(await safety.isVisible())) break;
    // The safety sheet takes Esc like any sheet, and hands focus back to where it was.
    if (by === "click") await safety.getByRole("button", { name: "Close" }).click();
    else await page.keyboard.press("Escape");
    await expect(safety).toHaveCount(0);
    if (by === "keyboard") await refocus();
  }
  // Open, the review has its own Start and Hide; the card's own button is hidden meanwhile.
  await expect(card.getByRole("button", { name: "Review and start", exact: true })).toHaveCount(0);
  return review;
}

/**
 * Asserts that something has keyboard focus and shows it: a focus outline; for Pip's input, which draws its ring as
 * its border, the border in Pip's colour; for a pane's resize handle, its lit bar. Returns a short description of the focused element.
 */
export async function expectVisibleFocus(page: Page) {
  const look = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { ok: false, what: "nothing" };
      const style = getComputedStyle(el);
      const what = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}[${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}]`;
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) return { ok: true, what };
      // A pane's resize handle lights its bar instead.
      const bar = getComputedStyle(el, "::after").backgroundColor;
      if (el.classList.contains("ws-resize-handle")) return { ok: bar !== "rgba(0, 0, 0, 0)" && bar !== "transparent", what };
      if (el.id !== "pip-input") return { ok: false, what };
      const probe = document.createElement("div");
      probe.className = "bg-ws-pip";
      document.body.append(probe);
      const pip = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { ok: style.borderTopColor === pip, what };
    });
  // Focus that moves on a frame later, as after a review closes, gets a moment to land.
  let seen = await look();
  await expect.poll(async () => (seen = await look()).ok, { message: "the focused element shows a focus ring", timeout: 2000 }).toBe(true).catch(() => undefined);
  expect(seen.ok, `the focused ${seen.what} shows no focus ring`).toBe(true);
  return seen.what;
}

const agentSetup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const agentSafety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
/** The Agents view's cards; Pip's strip of agents shows runs too, and only the view counts. */
const agentCards = (page: Page) => page.locator('main article[data-run-id]:not(aside[aria-label="Pip"] *)');
const agentRunIds = async (page: Page) => (await agentCards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")))).filter((id): id is string => !!id);

/**
 * Starts a Review of CA-402's build (pull request #218 in acme/webshop) from Review this, as review-verdict.spec does,
 * advances it to done, and opens CA-402's peek, where its GitHub review draft waits. `query` is added to the page's.
 */
export async function reviewedDraft(page: Page, query = "") {
  await page.goto(`/?mockRepos=14${query}`);
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Agents/ }).click();
  await expect(agentCards(page).first()).toBeVisible();
  const before = await agentRunIds(page);
  const build = agentCards(page).filter({ hasText: "Build" }).filter({ hasText: "CA-402" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await build.getByRole("button", { name: "Review this" }).click();
    await expect(agentSetup(page).or(agentSafety(page))).toBeVisible();
    if (!(await agentSafety(page).isVisible())) break;
    await agentSafety(page).getByRole("button", { name: "Close" }).click();
    await expect(agentSafety(page)).toHaveCount(0);
  }
  await agentSetup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(agentSetup(page)).toHaveCount(0);
  await expect.poll(async () => (await agentRunIds(page)).length).toBe(before.length + 1);
  const id = (await agentRunIds(page)).find((r) => !before.includes(r))!;
  await advanceRuns(page, 3, id);
  await expect(agentCards(page).and(page.locator(`[data-run-id="${id}"]`))).toHaveAttribute("data-state", "done");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await peekTicket(page, "CA-402");
  const review = peekSheet(page).getByRole("article", { name: "GitHub review of acme/webshop#218" });
  await expect(review).toHaveCount(1);
  return review;
}

/**
 * Waits for a toast saying `text`. Toasts come one at a time (src/workspace/ToastHost.tsx), so the ones queued ahead of it
 * are dismissed as the person would, until it is the one on screen.
 */
export async function expectToast(page: Page, text: string | RegExp) {
  const toast = page.locator("[data-toast]");
  await expect
    .poll(
      async () => {
        if (await toast.filter({ hasText: text }).count()) return true;
        if (await toast.count()) await toast.getByRole("button", { name: "Dismiss" }).click({ timeout: 1000 }).catch(() => {});
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}
