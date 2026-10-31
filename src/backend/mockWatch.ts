import type { Step } from "../lib/roles";
import { AUTO_WATCH_EVERYTHING_MAX, type ContainerRef, type Intent, type ItemRef, type Proposal, type WatchChange, type WatchRow, type WatchState, type WorkstreamActor } from "../types";
import { docText } from "../lib/docs";
import type { GithubWrite } from "./mockGithub";
import { PROBE_STATES, type GithubProbeState } from "./mockProbes";
import type { ScriptedFinish } from "./mockRunResult";
import type { MockLaunch } from "./mockRuns";

export interface MockOptions {
  /** How many projects the catalog lists, at least the four that hold sample items. Above 12 the choice of what to watch starts unset. */
  catalogSize?: number;
  /** When set, a GitHub connection is already signed in with this many repositories (at least the five sample ones). Without it the sign-in commands connect one with 14. */
  githubRepos?: number;
  /** What the probe of the GitHub instance finds from the start (`?mockGithubProbe=notSignedIn`). */
  githubProbe?: GithubProbeState;
  /** "hold" keeps the sample GitHub checking its drafts after it is turned back on until `finishGithubRecheck()` (`?mockGithubRecheck=hold`). */
  githubRecheck?: "hold";
  /** What the sample Jira token is like from the start: close to its expiry, or turned down (`?mockJiraToken=expiring` or `refused`). */
  jiraToken?: "expiring" | "refused";
  /** Which scripted agent runs exist, and the moment their ages count back from. */
  /** How long the scripted Pip waits between words, in ms (a step takes six times as long); unset keeps its usual pace. */
  pipPace?: number;
  /** "none" is a GitHub token that can't write to pull requests anywhere, so no review draft can be posted. */
  reviewAccess?: "none";
  runs?: { seed?: "busy" | "kinds" | "empty" | "many" | "failures" | "stuck" | "reports"; epoch?: number; cap?: number; planDescription?: boolean; untrusted?: boolean; prSurfaceMs?: number | null };
}

interface Stored {
  pinned: boolean;
  source: WatchRow["source"];
  addedAt: string;
  inaccessible: boolean;
}

/** What a connection follows, kept the way the backend keeps it: a list that is the person's own once they watch something. */
export class MockWatch {
  chosen = false;
  private rows = new Map<string, Stored>();

  constructor(
    private readonly connectionId: string,
    readonly catalogSize: number,
  ) {}

  /** Ids of the containers that may be shown, or null when every one may. */
  visible(): Set<string> | null {
    return this.chosen ? new Set(this.rows.keys()) : null;
  }

  isWatched(containerId: string): boolean {
    return this.visible()?.has(containerId) ?? true;
  }

  /** Nothing is chosen and the catalog is too big to watch whole. */
  get needsChoice() {
    return !this.chosen && this.catalogSize > AUTO_WATCH_EVERYTHING_MAX;
  }

  apply(changes: WatchChange[], at = new Date().toISOString()) {
    if (changes.some((c) => c.watched === true)) this.chosen = true;
    for (const c of changes) {
      const row = this.rows.get(c.containerId);
      if (c.watched === false) {
        this.rows.delete(c.containerId);
        continue;
      }
      if (!row) {
        if (this.chosen && c.watched !== true) continue;
        this.rows.set(c.containerId, { pinned: c.pinned ?? false, source: c.source ?? "manual", addedAt: at, inaccessible: false });
        continue;
      }
      row.pinned = c.pinned ?? row.pinned;
      row.source = c.source ?? row.source;
      if (c.watched === true) row.inaccessible = false;
    }
  }

  state(describe: (id: string) => { key: string; name: string; cachedItems: number }): WatchState {
    const watches: WatchRow[] = [...this.rows].map(([id, r]) => {
      const container: ContainerRef = { connectionId: this.connectionId, externalId: id };
      return { container, ...r, ...describe(id) };
    });
    return {
      connectionId: this.connectionId,
      chosen: this.chosen,
      needsChoice: this.needsChoice,
      catalogSize: Math.min(this.catalogSize, AUTO_WATCH_EVERYTHING_MAX + 1),
      watches,
    };
  }
}

/** What the sample backend hands a dev browser to drive it from outside, as the e2e tests do (`advanceRuns` in e2e/support/app.ts). */
export interface MockHandle {
  /** Moves one run, or every unfinished run, a step along (queued, launching, working, done), as `MockRuns.advance` does. */
  advanceRuns(id?: string): void;
  /** The audit of every workstream, oldest first within each, as `workstreams_events` reads one. */
  workstreamEvents(): { workstreamId: string; actor: string; action: string; runId: string | null; detail?: string | null }[];
  /** Every run the sample backend holds, newest first: its id, role and state. */
  runs(): { id: string; role: string; state: string; prSha: string | null; passes: number; key: string | null; shortId: string | null; digest: string; name: string }[];
  /** Every launch so far, oldest first: the run, its role and the guard the mock launcher passed. */
  launches(): MockLaunch[];
  /** Makes the draft pull requests finished builds opened show on the code host now, as a code sync finding them; true when there was one. */
  surfacePullRequests(): boolean;
  /** The next run of the step `kind` names to finish writes this: a triage's plan recommendation, a review's verdict, or a data marker. */
  scriptNext(kind: Step, script: ScriptedFinish): void;
  /**
   * Starts an agent with `role` on ticket `key` as Pip's `start_agent` does, in the ticket's open workstream when it has one;
   * `over.pr` has it check out a pull request in `over.repo`. Returns the run's id.
   */
  startAgent(key: string, role: string, over?: { brief?: string; pr?: number; repo?: string }): string;
  /** Has working run `id` ask the person `question`, as `MockRuns.ask` does. */
  askRun(id: string, question: string): void;
  /** Has working run `id` ask permission for `needs` (`approve Bash: git push`), as `MockRuns.askPermission` does. */
  askPermission(id: string, needs: string): void;
  /** Has working run `id` be blocked on Claude's sign-in, as `MockRuns.block` does. */
  blockRun(id: string): void;
  /** Has run `id` go unclear, as `MockRuns.lose` does. */
  loseRun(id: string): void;
  /** The run ids Terminal was opened on (`runsAttach`), oldest first. */
  attached(): string[];
  /** The commands Terminal was opened on from a connection's detail, oldest first. */
  connectionTerminals(): string[];
  /** Every write the sample tracker made, oldest first, with the draft the person approved for it. */
  /** What was written to Jira, oldest first: the draft, the kind of write, its ticket and, for a comment, its text as posted. */
  jiraWrites(): { proposalId: string; type: string; key: string | null; text?: string }[];
  /** Every GitHub review draft, newest first: its pull request, the run it came from, its state, what replaced it and whether the person edited it. */
  reviewDrafts(): MockReviewDraft[];
  draftReview(runId: string, reviewedSha: string, summary: string, comments: import("../types").ReviewComment[]): void;
  /** Adds an audit line to the open workstream on ticket `key` as of `at` (an ISO time), the way to age what depends on the time since: the sample's clock is the browser's and can't be moved. */
  seedWorkstreamEvent(key: string, event: { actor: string; action: string; at: string; runId?: string | null; proposalId?: string | null; detail?: string | null }): void;
  /** Pauses the open workstream on ticket `key` as the system would (`ceiling`), not as the person. */
  pauseWorkstream(key: string, reason: "person" | "ceiling"): void;
  /** Makes the scripted Pip wait, answering, after starting each turn (true) until let go (false). */
  holdPip(on: boolean): void;
  /** Whether the scripted Pip has no turn running or waiting anywhere, a wake the supervisor queued included. */
  pipIdle(): boolean;
  /** Changes sample ticket `key` as someone editing it in Jira would (`MockBackend.editTicket`): its summary, description or status (an id or a name). */
  editTicket(key: string, change: TicketEdit): void;
  /** Marks pending draft `id` as edited by the person, so a newer draft of the same kind stays beside it. */
  noteEdited(id: string): void;
  /** Every review the sample GitHub was sent, oldest first: the only writes it takes, each from a draft the person approved. */
  githubWrites(): GithubWrite[];
  /** Someone pushes to pull request `number` of `repo`: its head moves to a new commit whose diff lacks the lines it showed. */
  movePullHead(repo: string, number: number): boolean;
  /** How many reviews the sample GitHub was asked to post, refused ones included. */
  githubPostsTried(): number;
  /** Has the probe of the GitHub instance find `state`, and tells the page as a `connections` event does. */
  probeGithub(state: GithubProbeState): void;
  refuseGithubToken(): void;
  /** Ends the sample GitHub's check of its waiting drafts after it was turned back on, as its first sync finishing does. */
  finishGithubRecheck(): void;
  /** The next review post's answer is lost, as a 502: GitHub keeps the review when `kept`, and drops it otherwise. */
  loseNextReviewAnswer(kept: boolean): void;
}

/** A GitHub review draft as `reviewDrafts` lists it. */
export interface MockReviewDraft {
  id: string;
  runId: string;
  pull: string;
  state: string;
  supersededBy: string | null;
  edited: boolean;
}

/** What `editTicket` changes on a sample ticket; the status is a status id or its name. */
export interface TicketEdit {
  summary?: string;
  description?: string;
  statusId?: string;
}

/** The parts of the sample backend the handle reaches. */
export interface MockClockParts {
  runs: { advance(id?: string): void; list(): { id: string; spec: { role: string; prSha?: string | null; name: string }; state: string; passes?: number; item?: { key: string } | null; shortId?: string | null; digest: string }[]; surfacePullRequests(): boolean; launches(): MockLaunch[]; scriptNext(kind: Step, script: ScriptedFinish): void; pipStart(a: { workstream: string | null; role: string; brief: string | null; repo: string | null; pr?: number | null; item: ItemRef | null }, requestId: string): { id: string }; ask(id: string, question: string): unknown; askPermission(id: string, needs: string): unknown; block(id: string): unknown; lose(id: string): unknown; readonly attached: readonly string[] };
  workstreams?: { list(includeClosed?: boolean): { workstream: { id: string; itemKey: string | null; closedAt: string | null } }[]; events(id: string): MockHandleEvent[]; pause(id: string, reason: "person" | "ceiling", actor: "supervisor"): unknown; seedEvent(id: string, actor: WorkstreamActor, action: string, at: string, extra?: { runId?: string | null; proposalId?: string | null; detail?: string | null }): unknown };
  draftReview: MockHandle["draftReview"];
  proposals?: { writes: readonly { proposalId: string; intent: Intent }[]; list(): Proposal[]; noteEdited(id: string): void };
  pip?: { hold(on: boolean): void; idle(): boolean };
  tickets?: { edit(key: string, change: TicketEdit): void };
  terminals?: readonly string[];
  github?: { probe(state: GithubProbeState): void; refuseToken(): void; finishRecheck(): void; writes: readonly GithubWrite[]; movePullHead(repo: string, number: number): boolean; tried(): number; loseNextAnswer(kept: boolean): void };
}

declare global {
  /** Set by the sample backend in a dev browser only; see `exposeMockClock`. */
  var __gossamrMock: MockHandle | undefined;
}

/**
 * The scripted runs never move by themselves, so in a dev browser (never a build, never a test outside a browser) the sample
 * backend puts its clock on `globalThis.__gossamrMock`: `__gossamrMock.advanceRuns()` steps every unfinished run along and
 * `advanceRuns(id)` one run; `workstreamEvents()` reads the workstreams' audit, `runs()` lists the runs, `askPermission(id, needs)` has a run ask permission, `attached()` lists the runs Terminal was opened on, `reviewDrafts()` lists the GitHub review drafts, `launches()` lists every
 * launch with the guard the mock launcher passed Claude Code, and `surfacePullRequests()` shows the
 * draft pull requests finished builds opened without waiting, `githubWrites()` lists the reviews posted to the sample GitHub,
 * `movePullHead(repo, number)` force-pushes a pull request, `githubPostsTried()` counts the posts asked for and
 * `loseNextReviewAnswer(kept)` loses the next post's answer, and `probeGithub(state)` has the GitHub probe find `ready`, `notSignedIn`, `notFound`, `error` or `off`, and `refuseGithubToken()` has GitHub turn down the stored token. The last sample backend made wins.
 */
export function exposeMockClock({ runs, workstreams, proposals, pip, tickets, github, terminals, draftReview }: MockClockParts) {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  globalThis.__gossamrMock = {
    advanceRuns: (id) => runs.advance(id),
    workstreamEvents: () => (workstreams ? workstreams.list(true).flatMap((v) => workstreams.events(v.workstream.id)) : []),
    runs: () => runs.list().map((r) => ({ id: r.id, role: r.spec.role, state: r.state, prSha: r.spec.prSha ?? null, passes: r.passes ?? 1, key: r.item?.key ?? null, shortId: r.shortId ?? null, digest: r.digest, name: r.spec.name })),
    launches: () => runs.launches(),
    surfacePullRequests: () => runs.surfacePullRequests(),
    scriptNext: (kind, script) => runs.scriptNext(kind, script),
    startAgent: (key, role, over = {}) => {
      const ws = workstreams?.list().find((v) => v.workstream.itemKey === key && v.workstream.closedAt === null)?.workstream.id ?? null;
      return runs.pipStart({ workstream: ws, role, brief: over.brief ?? "Look into this work and report what you found.", repo: over.repo ?? null, pr: over.pr ?? null, item: { connectionId: "mock", externalId: key, key } }, `handle-${Date.now()}-${Math.random()}`).id;
    },
    askRun: (id, question) => void runs.ask(id, question),
    askPermission: (id, needs) => void runs.askPermission(id, needs),
    blockRun: (id) => void runs.block(id),
    loseRun: (id) => void runs.lose(id),
    attached: () => [...runs.attached],
    connectionTerminals: () => [...(terminals ?? [])],
    jiraWrites: () => (proposals?.writes ?? []).map((w) => ({ proposalId: w.proposalId, type: w.intent.type, key: writtenKey(w.intent), ...(w.intent.type === "comment" ? { text: docText(w.intent.body) } : {}) })),
    draftReview,
    reviewDrafts: () =>
      (proposals?.list() ?? []).flatMap((p) =>
        p.intent.type === "githubReview"
          ? [{ id: p.id, runId: p.intent.runId, pull: `${p.intent.repo.toLowerCase()}#${p.intent.number}`, state: p.state.type, supersededBy: p.supersededBy ?? null, edited: p.revisions.some((r) => r.note === "Edited") }]
          : [],
      ),
    seedWorkstreamEvent: (key, { actor, action, at, runId, proposalId, detail }) => {
      const ws = workstreams?.list().find((v) => v.workstream.itemKey === key && v.workstream.closedAt === null);
      if (!ws) throw new Error(`no open workstream on ${key}`);
      workstreams?.seedEvent(ws.workstream.id, actor as WorkstreamActor, action, at, { runId, proposalId, detail });
    },
    pauseWorkstream: (key, reason) => {
      const ws = workstreams?.list().find((v) => v.workstream.itemKey === key && v.workstream.closedAt === null);
      if (!ws) throw new Error(`no open workstream on ${key}`);
      workstreams?.pause(ws.workstream.id, reason, "supervisor");
    },
    holdPip: (on) => pip?.hold(on),
    pipIdle: () => pip?.idle() ?? true,
    editTicket: (key, change) => tickets?.edit(key, change),
    noteEdited: (id) => {
      if (!proposals) throw new Error("the sample clock has no drafts");
      proposals.noteEdited(id);
    },
    githubWrites: () => (github?.writes ?? []).map((w) => ({ ...w, comments: w.comments.map((c) => ({ ...c })) })),
    movePullHead: (repo, number) => github?.movePullHead(repo, number) ?? false,
    githubPostsTried: () => github?.tried() ?? 0,
    probeGithub: (state) => github?.probe(state),
    refuseGithubToken: () => github?.refuseToken(),
    finishGithubRecheck: () => github?.finishRecheck(),
    loseNextReviewAnswer: (kept) => github?.loseNextAnswer(kept),
  };
}

/** The ticket a write went to, by key, for the e2e tests to read. */
function writtenKey(intent: Intent): string | null {
  switch (intent.type) {
    case "comment":
    case "rewrite":
    case "transition":
      return intent.item.key;
    case "subtasks":
      return intent.parent.key;
    default:
      return null;
  }
}

type MockHandleEvent = ReturnType<MockHandle["workstreamEvents"]>[number];

/** In a dev browser, `?mockProjects=60` sets how many projects the sample catalog lists, and `?mockRepos=30` signs in a GitHub connection with that many repositories. `?runs=busy` (without the other kinds), `empty`, `many`, `failures` or `reports` (a finished run for each way a result can have been read) changes the scripted agent runs, `?runsCap=3` sets how many agents may run at once `?runsUntrusted=1` makes Claude refuse every clone until Trust this folder is used. `?prSurface=manual` keeps a finished build's draft pull request off the code host until `__gossamrMock.surfacePullRequests()` (or Sync now) shows it, rather than after a moment. `?pipPace=200` slows the scripted Pip to 200ms a word, so a question can be queued behind one it is still answering. `?mockGithubProbe=notSignedIn` (or another state) sets what the GitHub probe finds from the start. `?mockGithubRecheck=hold` keeps the sample GitHub checking its drafts after it is turned back on until `__gossamrMock.finishGithubRecheck()`. `?mockJiraToken=expiring` or `refused` gives the sample connection a token close to its expiry, or one Jira turned down (the banner asks for a new one). `?mockReviewAccess=none` makes the GitHub token unable to write to any pull request, so a review draft can't be posted and its card offers GitHub instead (repositories the sample can only read never take a review either). The runs move only when told to: see `exposeMockClock` above for `__gossamrMock.advanceRuns()`. */
export function mockOptionsFromUrl(): MockOptions {
  if (!import.meta.env.DEV || typeof location === "undefined") return {};
  const params = new URLSearchParams(location.search);
  const count = (name: string) => {
    const n = Number(params.get(name));
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const options: MockOptions = {};
  const projects = count("mockProjects");
  const repos = count("mockRepos");
  if (projects) options.catalogSize = projects;
  if (repos) options.githubRepos = repos;
  const probe = params.get("mockGithubProbe");
  if (PROBE_STATES.some((s) => s === probe)) options.githubProbe = probe as GithubProbeState;
  if (params.get("mockGithubRecheck") === "hold") options.githubRecheck = "hold";
  const jiraToken = params.get("mockJiraToken");
  if (jiraToken === "expiring" || jiraToken === "refused") options.jiraToken = jiraToken;
  const pace = count("pipPace");
  if (pace) options.pipPace = pace;
  if (params.get("mockReviewAccess") === "none") options.reviewAccess = "none";
  const seed = params.get("runs");
  options.runs = {
    // The scripted ages count back from now, so the runs look recent whenever the page is opened.
    epoch: Date.now(),
    seed: seed === "empty" || seed === "many" || seed === "failures" || seed === "busy" || seed === "stuck" || seed === "reports" ? seed : "kinds",
    cap: count("runsCap"),
    planDescription: true,
    untrusted: params.get("runsUntrusted") === "1",
    prSurfaceMs: params.get("prSurface") === "manual" ? null : undefined,
  };
  return options;
}
