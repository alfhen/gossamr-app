import { expect, type Locator, type Page } from "@playwright/test";

/** The id of Pip's message input (PIP_INPUT_ID in src/workspace/PipPane.tsx). */
export const PIP_INPUT = "#pip-input";

/** The app lands on Agents once it is ready; this leaves it for the ticket screen, where most specs start. */
export async function showWorkspace(page: Page) {
  await expect(page).toHaveTitle("Agents — Gossamr");
  await page.getByRole("button", { name: "All projects" }).click();
  await page.mouse.move(700, 500);
  await expect(page).toHaveTitle("Tickets — Gossamr");
}

/**
 * Opens the workspace in mock mode and waits for the sample tickets. `query` goes through as the page's search string, so mock
 * flags such as `runs=empty` reach mockOptionsFromUrl. The app lands on Agents; the specs here start on the workspace
 * (`showWorkspace`) and go to Agents when they mean to.
 */
export async function openApp(page: Page, query = "") {
  await page.goto(query ? `/?${query.replace(/^\?/, "")}` : "/");
  await showWorkspace(page);
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
 * Peeks `key` and presses 'Ask Pip' there, then waits for the Pip pane to show the workstream's own
 * conversation, still at intake.
 */
export async function startWorkstream(page: Page, key: string) {
  await peekTicket(page, key);
  await peekSheet(page).locator("[data-ask-pip]").click();
  await expect(pipConversation(page)).toHaveText(new RegExp(`^Workstream: ${key} .* · Intake$`));
}

/**
 * Marks every pending comment draft as edited by the person. A newer comment on the same ticket then stays beside it,
 * which is how two of Pip's comments can both be waiting.
 */
export async function keepComments(page: Page) {
  const ids = await page.locator('article[data-draft][data-state="pending"]').evaluateAll((els) => [
    ...new Set(
      els.flatMap((el) => {
        const id = el.getAttribute("data-draft");
        const title = el.querySelector("h3")?.textContent ?? "";
        return id && title.startsWith("Comment on") ? [id] : [];
      }),
    ),
  ]);
  for (const id of ids) {
    await page.evaluate((draftId) => {
      const mock = (globalThis as { __gossamrMock?: { noteEdited(id: string): void } }).__gossamrMock;
      if (!mock) throw new Error("the sample backend's clock isn't there; is this a dev build in mock mode?");
      mock.noteEdited(draftId);
    }, id);
  }
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
/** One launch as the mock launcher made it (`MockLaunch` in src/backend/mockRuns.ts). */
export type MockLaunch = { runId: string; role: string; guard: string; at: string };
interface Handle {
  runs(): { id: string; role: string; state: string; prSha: string | null; passes: number; key: string | null; shortId: string | null; digest: string; name: string }[];
  launches(): MockLaunch[];
  workstreamEvents(): { workstreamId: string; actor: string; action: string; runId: string | null; detail?: string | null }[];
  scriptNext(kind: string, script: Script): void;
  startAgent(key: string, role: string, over?: { brief?: string; pr?: number; repo?: string }): string;
  askRun(id: string, question: string): void;
  askPermission(id: string, needs: string): void;
  blockRun(id: string): void;
  loseRun(id: string): void;
  attached(): string[];
  jiraWrites(): { proposalId: string; type: string; key: string | null; text?: string }[];
  reviewDrafts(): ReviewDraftRow[];
  seedWorkstreamEvent(key: string, event: { actor: string; action: string; at: string; runId?: string | null; proposalId?: string | null; detail?: string | null }): void;
  pauseWorkstream(key: string, reason: "person" | "ceiling"): void;
  holdPip(on: boolean): void;
  pipIdle(): boolean;
  editTicket(key: string, change: TicketEdit): void;
  commentOnTicket(key: string, text: string, by?: string): void;
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

const STEPS: Record<string, string> = { investigator: "investigate", triager: "triage", planner: "plan", builder: "build", reviewer: "review", verifier: "verify" };
/** The step a role names (`planner` is `plan`), or the role itself for any other label. */
export const stepOf = (role: string) => STEPS[role] ?? role;

/** Every run the sample backend holds, newest first, with the step its role names. */
export const mockRuns = async (page: Page) => {
  const runs = await page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.runs();
  }, NO_MOCK);
  return runs.map((r) => ({ ...r, step: stepOf(r.role) }));
};

/** Every launch the sample backend made, oldest first, with the guard it would pass Claude Code. */
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

/** Starts an agent with `role` on ticket `key` as Pip's start_agent does and returns its run id; `over.pr` and `over.repo` have it check out a pull request. */
export const startAgent = (page: Page, key: string, role: string, over: { brief?: string; pr?: number; repo?: string } = {}) =>
  page.evaluate(
    ({ key, role, over, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      return mock.startAgent(key, role, over);
    },
    { key, role, over, missing: NO_MOCK },
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

/** Pauses the open workstream on ticket `key` as the system does at its daily ceiling of Pip wakes: a pause that Resume lifts. */
export const pauseAtCeiling = (page: Page, key: string) =>
  page.evaluate(
    ({ key, missing }) => {
      const mock = (globalThis as Mocked).__gossamrMock;
      if (!mock) throw new Error(missing);
      mock.pauseWorkstream(key, "ceiling");
    },
    { key, missing: NO_MOCK },
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

/** Pip's wake turns in the pane, the ones nobody asked; `wakeTurns` counts them. */
export const wakes = (page: Page) => pipPane(page).locator('[data-turn-kind="wake"]');
export const wakeTurns = (page: Page) => wakes(page).count();

/** The banner saying why the pane's workstream is paused, with its Resume. */
export const pausedBanner = (page: Page) => pipPane(page).locator("[data-paused-banner]");

/** The Agents view (src/workspace/AgentsView.tsx): the summary chips, the workstreams with their agents, and a workstream's detail beside them. */
export const agentsHome = (page: Page) => page.locator("[data-agents-home]");

/**
 * Opens Agents from the rail and waits for the view. Just after a load the button does nothing until the settings that
 * enable agents have arrived, so it is pressed again until the view shows. The Pip drawer is left as it is.
 */
export async function openAgents(page: Page) {
  await expect(async () => {
    if (!(await agentsHome(page).count())) await page.locator("[data-rail]").getByRole("button", { name: /^Agents/ }).click({ timeout: 1_000 });
    await expect(agentsHome(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

/** Opens "What Jira saw from me" from the palette. */
export async function openJiraSent(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("what jira saw");
  await palette.getByRole("option", { name: /^What Jira saw from me/ }).click();
  await expect(page.locator("[data-jira-sent]")).toBeVisible();
}

/** Groups the Agents list by state, its lanes, which Agents does not do by default (it groups by workstream). */
export async function groupByState(page: Page) {
  await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "State" }).click();
  await expect(agentsHome(page).locator("[data-lane]").first()).toBeVisible();
}

/** Closes the Pip drawer when it is open. */
export async function closePipDrawer(page: Page) {
  if (await pipPane(page).count()) await pipPane(page).getByRole("button", { name: "Close Pip" }).click();
  await expect(pipPane(page)).toHaveCount(0);
}

/** A workstream's detail, the sheet over the Agents view. */
export const workstreamSheet = (page: Page) => page.locator("#workstream-sheet");

/** The group of the open workstream on ticket `key` in the Agents list: its heading, status and agents. */
export const workstreamGroup = (page: Page, key: string) => agentsHome(page).locator("[data-workstream-group]").filter({ has: page.locator("h3", { hasText: key }) });

/** The button that opens the detail of the workstream on ticket `key`. */
export const workstreamOpen = (page: Page, key: string) => workstreamGroup(page, key).locator("[data-workstream-open]");

/**
 * Opens the detail of the workstream on ticket `key` and, for the conversation that goes with it, the Pip drawer: Pip talks
 * about the workstream whose detail is open. Waits until both show it.
 */
export async function selectWorkstream(page: Page, key: string) {
  await workstreamOpen(page, key).click();
  await expect(workstreamSheet(page)).toBeVisible();
  if (!(await pipPane(page).count())) await openPip(page);
  await expect(pipConversation(page)).toHaveText(new RegExp(`^Workstream: ${key}\\b`));
}

/** Puts the open workstream's detail away, so Pip's conversation is General's again. */
export async function closeWorkstreamSheet(page: Page) {
  if (await workstreamSheet(page).count()) await workstreamSheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(workstreamSheet(page)).toHaveCount(0);
}

/** The line at the head of the drawer's conversation, naming it: "General", or "Workstream: <title> · <Stage>". */
export const homeConversation = (page: Page) => pipPane(page).locator("h2[data-pip-conversation]");

/**
 * The peek over Agents sits in the window as it opened: nothing around it scrolled (a card focused in it once scrolled
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

/** Pip's composer input, the only Pip input on screen. */
export const homeComposer = (page: Page) => page.locator(PIP_INPUT);

/** The summary at the top of the Agents view: its filter chips (Needs you, Ready to review, Failed or stuck, All). */
export const needsYouTray = (page: Page) => agentsHome(page).locator("[data-summary-chips]");

/** The Needs you chip: a toggle that filters the list, with the one count. */
export const needsChip = (page: Page) => agentsHome(page).locator('[data-chip="needs"]');

/** The Needs you list's one count, as its chip says it. */
export const needsYouCount = (page: Page) => needsYouTray(page).locator("[data-needs-you-count]");

/** The group of the workstream on ticket `key` in the Agents list, or No workstream's (`key` "General"). */
export const needsYouRow = (page: Page, key: string) => (key === "General" ? agentsHome(page).locator('[data-workstream-group="none"]') : workstreamGroup(page, key));

/** The button that opens the detail of the workstream on ticket `key`, or of No workstream (`key` "General"). */
export const groupOpen = (page: Page, key: string) => (key === "General" ? agentsHome(page).locator('[data-workstream-open="general"]') : workstreamOpen(page, key));

/** The Needs you section at the top of the open workstream's detail. */
export const needsStack = (page: Page) => workstreamSheet(page).locator("[data-workstream-needs]");

/** A need in the open detail's Needs you section, by the words it reads; pressing it opens it. */
export const needRow = (page: Page, name: string | RegExp) => workstreamSheet(page).locator("[data-needs-pane]").filter({ hasText: name }).locator("[data-need-row]");

/**
 * With a workstream open on Agents, asks Pip for a comment on its ticket and opens that draft in the decision pane.
 * Returns the draft's card; nothing is posted.
 */
export async function pipCommentDraft(page: Page, key: string) {
  await askPip(page, "Draft a comment");
  await homeSettled(page);
  await needRow(page, /Draft comment/).click();
  return needsPane(page).getByRole("article", { name: `Comment on ${key}` });
}

/** The need of `kind` ("permission", "question", "failure", "paused", "draft", ...) in the open detail. */
export const needOfKind = (page: Page, kind: string) => workstreamSheet(page).locator(`[data-needs-pane][data-kind="${kind}"] [data-need-row]`).first();

/**
 * Opens the rail's Needs you popover (a right click on the Agents button), which lists every need from any screen, and
 * presses the first row `pick` finds: the way a notification, the badge or a link takes the person to a need.
 */
export async function openNeedFromBadge(page: Page, pick: (list: Locator) => Locator) {
  await page.locator("[data-rail]").getByRole("button", { name: /^Agents/ }).click({ button: "right" });
  const popover = page.getByRole("dialog", { name: "Needs you" });
  await expect(popover).toBeVisible();
  const more = popover.locator('[data-needs-you-more][aria-expanded="false"]');
  const rows = popover.locator("[data-needs-you-group], [data-needs-you-need]");
  if (!(await pick(rows).count())) while (await more.count()) await more.first().click();
  await pick(rows).first().click();
}

/** Opens the sheet of the run on ticket `key` from its card in the Agents list, with the keyboard as j and Enter would. */
export async function openRunOf(page: Page, key: string) {
  const card = agentsHome(page).locator("article[data-run-id]").filter({ hasText: key }).first();
  await card.focus();
  await page.keyboard.press("Enter");
}

/** Opens the need of `kind` from the popover. */
export const openNeedOfKind = (page: Page, kind: string) => openNeedFromBadge(page, (rows) => rows.and(page.locator(`[data-kind="${kind}"]`)));

/** Opens the need reading `name` from the popover. */
export const openNeedRow = (page: Page, name: string | RegExp) => openNeedFromBadge(page, (rows) => rows.filter({ hasText: name }));

/** Opens the detail of the workstream on ticket `key` (or No workstream's, for "General") from the list, unless it is open. */
export async function expandNeedsYou(page: Page, key = "General") {
  if (!(await needsStack(page).count()) || (await groupOpen(page, key).getAttribute("aria-expanded")) !== "true") await groupOpen(page, key).click();
  await expect(needsStack(page)).toBeVisible();
}

/** Kept for the specs that expanded or folded the old list: a workstream's needs are one stack now. */
export async function expandAllNeeds(_page: Page) {}
export async function foldAllNeeds(_page: Page) {}

/** The decision open at the top of a workstream's detail. */
export const needsPane = (page: Page) => agentsHome(page).locator("[data-needs-pane][data-open]");

/** The open decision's heading: where the keyboard lands whenever a need is opened by a key or a link (G28). */
export const needsPaneHeading = (page: Page) => needsPane(page).locator("[data-needs-pane-title]");

/** The conversation, where Pip's cards are: the Pip drawer. */
export const homeConversationRegion = (page: Page) => page.locator("[data-pip-root]");

/** The step rail in an open workstream's detail. */
export const stepRail = (page: Page) => workstreamSheet(page);

/** The chip of step `kind` (investigate, triage, plan, build, review, verify) on the step rail, with what it opens to. */
export const stepChip = (page: Page, kind: string) => stepRail(page).locator(`[data-step="${kind}"]`);

/** Whether the scripted Pip has no turn running or waiting anywhere, a wake the supervisor queued included. */
export const pipIdle = (page: Page) =>
  page.evaluate((missing) => {
    const mock = (globalThis as Mocked).__gossamrMock;
    if (!mock) throw new Error(missing);
    return mock.pipIdle();
  }, NO_MOCK);

/**
 * Waits until Pip has finished answering in the drawer: the sample Pip has nothing running or waiting, a wake a run's
 * finish queued included, and the conversation shows every turn ended. No Stop on screen alone proves nothing until a
 * turn has started.
 */
export async function homeSettled(page: Page) {
  await expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);
  await expect(homeConversationRegion(page).locator('[data-turn-status="running"], [data-turn-status="queued"]')).toHaveCount(0);
  await expect(pipPane(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
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

/** Pip's wake turns in the drawer's conversation, the ones nobody asked. */
export const homeWakes = (page: Page) => pipPane(page).locator('[data-turn-kind="wake"]');

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

/**
 * Starts a Review of CA-402's build (pull request #218 in acme/webshop), as Pip's start_agent does, advances it to done,
 * and opens CA-402's peek, where its GitHub review draft waits. `query` is added to the page's.
 */
export async function reviewedDraft(page: Page, query = "") {
  await page.goto(`/?mockRepos=14${query}`);
  await page.getByRole("button", { name: "Start watching" }).click();
  await showWorkspace(page);
  await expect(page.getByText("CA-401", { exact: true }).first()).toBeVisible();
  const id = await startAgent(page, "CA-402", "reviewer", { repo: "acme/webshop", pr: 218 });
  await advanceRuns(page, 3, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
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

/**
 * Waits until `locator` has stopped moving: the same box on three reads in a row. A pane that opens moves its buttons for a
 * few frames as the column around it settles, and a click aimed in a pause of that can land where the button was.
 */
export async function still(locator: Locator) {
  let last = "";
  let same = 0;
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await locator.boundingBox());
        same = box === last && box !== "null" ? same + 1 : 0;
        last = box;
        return same >= 2;
      },
      { intervals: [50], message: "the element stopped moving" },
    )
    .toBe(true);
}

/** Opens the review's Technical details (its checks and the launch command) in `scope`, a sheet or an inline card, and returns it; one that opened itself over a check that needs the person stays as it is. */
export async function openTechnical(scope: Locator) {
  const details = scope.locator("[data-technical-details] > details");
  if ((await details.getAttribute("open")) === null) await details.locator("> summary").click();
  await expect(details).toHaveAttribute("open", "");
  return details;
}

/** The `<details>` of `scope` whose own summary says `summary`: not one around it. */
export const detailsOf = (scope: Locator, summary: string) => scope.locator(`xpath=.//details[summary[contains(., "${summary}")]]`);
