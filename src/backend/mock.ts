import { reviewText, SAMPLE_REVIEW_COMMENTS, SAMPLE_REVIEW_SUMMARY } from "./mockReviewDraft";
import type { ClearFilter } from "../types";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  ChangedFile,
  AssignedElsewhere,
  CacheChanged,
  CatalogPage,
  CodeRef,
  DevLinksChanged,
  FeedQuery,
  Footprint,
  Stray,
  WatchChange,
  WatchChanged,
  WatchState,
  ConnectionInfo,
  Comment,
  Intent,
  EventKind,
  InboxEvent,
  ItemRef,
  Person,
  Proposal,
  ProposalEdit,
  ProposalQuery,
  ProposalsChanged,
  ReviewComment,
  Run,
  RunQuery,
  RunsChanged,
  AgentSettings,
  Snapshot,
  Status,
  Ticket,
  WorkFilter,
  WorkItem,
  WorkstreamUndo,
  WorkstreamsChanged,
} from "../types";
import { stepOf } from "../lib/roles";
import { fold } from "../lib/mentions";
import { docFromText, docText } from "../lib/docs";
import { ticketBlockText } from "./mockTicket";
import { bodyChange, docFromMarkdown, markdownOf } from "./mockMarkdown";
import { MOCK_CONNECTION, MockConnector, PEOPLE, itemRef } from "./mockConnector";
import { basisFieldsOf, targetOf, workstreamOf } from "../lib/proposals";
import { workstreamConversation, workstreamOfConversation } from "../lib/conversations";
import { assemblePlan } from "./mockPlanSection";
import { withTriageSection } from "./mockTriageSection";
import { MockSupervisor } from "./mockSupervisor";
import { mockCancelTurns, mockCancelWakes, mockPipIdle, mockQueueWake } from "./mockPipQueue";
import { holdMockPip } from "./mockPip";
import { MockProposals } from "./mockProposals";
import { mockPipTurns } from "./mockPipTurns";
import { MockWorkstreams, lastDriftOf, type LastDrift } from "./mockWorkstreams";

/** Where the sample backend keeps the drafts Pip made in its conversations. */
const KEPT_DRAFTS = "gossamr-mock-pip-drafts";
import { MockRuns, STOPPABLE } from "./mockRuns";
import { seedDrafts } from "./mockDrafts";
import { exposeMockClock, type MockOptions, type TicketEdit } from "./mockWatch";
import { GITHUB_CONNECTION, MockGithub } from "./mockGithub";
import { jiraSnapshot } from "./mockProbes";
import type { Backend, ReadScope } from "./types";

export type { MockOptions };

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const P = {
  me: { accountId: "me", name: "Alf Henderson" },
  sam: { accountId: "sam", name: "Sam Holt" },
  mette: { accountId: "mette", name: "Mette Lund" },
  jonas: { accountId: "jonas", name: "Jonas Berg" },
  priya: { accountId: "priya", name: "Priya Nair" },
} satisfies Record<string, Person>;

/** People who aren't on any sample ticket, so mention search has something to find. */
const EXTRA_PEOPLE: Person[] = [
  { accountId: "lars", name: "Lars Møller" },
  { accountId: "soren", name: "Søren Ødegård" },
  { accountId: "ida", name: "Ida Kjær" },
];

const S = {
  todo: { name: "To Do", category: "new" },
  prog: { name: "In Progress", category: "indeterminate" },
  review: { name: "In Review", category: "indeterminate" },
  blocked: { name: "Blocked", category: "indeterminate" },
  done: { name: "Done", category: "done" },
} satisfies Record<string, Status>;

let seq = 1000;
const id = () => String(++seq);
const comment = (author: Person, minutesAgo: number, body: string): Comment => ({
  id: id(),
  author,
  created: ago(minutesAgo),
  body,
});

function ticket(t: Partial<Ticket> & Pick<Ticket, "key" | "summary" | "type" | "status">): Ticket {
  return {
    priority: "Medium",
    assignee: null,
    reporter: null,
    parent: null,
    description: "",
    comments: [],
    changes: [],
    subtasks: [],
    children: [],
    dueDate: null,
    sprint: null,
    url: `https://example.atlassian.net/browse/${t.key}`,
    updated: ago(60 * 24),
    ...t,
  };
}

function sampleSnapshot(): Snapshot {
  const epic = { key: "CA-400", summary: "Campaign translation pipeline" };
  const tickets: Ticket[] = [
    ticket({
      ...epic,
      type: "Epic",
      status: S.prog,
      priority: "High",
      assignee: P.mette,
      reporter: P.mette,
      dueDate: "2026-10-17",
      description:
        "Translate and roll out campaigns to every store automatically, with a human approval step before anything is sent.",
      children: ["CA-405", "CA-409", "CA-412", "CA-418", "CA-420", "CA-421"],
      comments: [comment(P.mette, 60 * 50, "@Alf can you confirm the 17 Oct go-live works for the CRM side?")],
      changes: [{ field: "Due date", from: "10 Oct", to: "17 Oct", author: P.mette, at: ago(180) }],
      updated: ago(180),
    }),
    ticket({
      key: "CA-412",
      summary: "Split translation rollout into parallel workers",
      type: "Story",
      status: S.prog,
      priority: "High",
      assignee: P.me,
      reporter: P.mette,
      parent: epic,
      sprint: "CRM 41",
      description:
        "Large campaigns take over an hour to roll out because translations run one language at a time. Run languages in parallel workers so a 12-language campaign finishes in under 15 minutes.",
      subtasks: [
        { key: "CA-413", summary: "Worker pool config in Horizon", done: true },
        { key: "CA-414", summary: "Fan-out job per language", done: true },
      ],
      comments: [
        comment(P.jonas, 60 * 48, "Horizon has room for 8 more workers on the queue box."),
        comment(P.me, 60 * 20, "Parallel workers are in. 12 languages now take 11 minutes on staging."),
        comment(P.mette, 22, "Can we cap concurrency per store? The DKK account is small and I don't want it hitting limits."),
      ],
      changes: [{ field: "Sprint", from: "CRM 40", to: "CRM 41", author: P.mette, at: ago(25) }],
      updated: ago(22),
    }),
    ticket({
      key: "CA-418",
      summary: "Retry translation batches when Klaviyo rate-limits us",
      type: "Story",
      status: S.blocked,
      priority: "High",
      assignee: P.sam,
      reporter: P.me,
      parent: epic,
      sprint: "CRM 41",
      description:
        "Overnight rollouts fail when Klaviyo returns 429. Batches should back off and retry instead of failing the whole campaign.\n\nDone when a 429 on one batch never fails the rollout, and retries show up in the rollout status.",
      comments: [comment(P.sam, 4, "@Alf do we know the per-account rate limit on the euro store? Batches keep failing around 02:00.")],
      changes: [{ field: "Status", from: "In Progress", to: "Blocked", author: P.sam, at: ago(5) }],
      updated: ago(4),
    }),
    ticket({
      key: "CA-420",
      summary: "Rollout status shows stale state after a retry",
      type: "Bug",
      status: S.review,
      priority: "High",
      assignee: P.jonas,
      reporter: P.me,
      parent: epic,
      sprint: "CRM 41",
      description: "After a batch is retried, the rollout status endpoint keeps reporting the failed state until the next full refresh.",
      descriptionDoc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "After a batch is retried, " },
              { type: "text", text: "GET /rollouts/:id/status", marks: [{ type: "code" }] },
              { type: "text", text: " keeps reporting the " },
              { type: "text", text: "failed", marks: [{ type: "strong" }] },
              { type: "text", text: " state until the next full refresh. The status is read from a cached row:" },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "php" },
            content: [{ type: "text", text: "$status = Rollout::query()\n    ->where('id', $id)\n    ->remember(300)\n    ->value('status');" }],
          },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Retry the batch from the dashboard" }] }] },
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Status stays failed for up to 5 minutes" }] }] },
            ],
          },
          {
            type: "panel",
            attrs: { panelType: "warning" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Customers see this as a failed send and retry again." }] }],
          },
        ],
      },
      comments: [
        comment(P.me, 60 * 70, "Repro: retry batch 7 on the euro store and the status stays failed for about 5 minutes."),
        comment(P.jonas, 60 * 20, "Pushed a fix: retries now re-read state before reporting. PR is up."),
        comment(P.sam, 38, "Looks good. One question on the retry backoff: is 30s enough for the euro store?"),
      ],
      changes: [{ field: "Status", from: "In Progress", to: "In Review", author: P.jonas, at: ago(60) }],
      updated: ago(60),
    }),
    ticket({
      key: "CA-405",
      summary: "Alert when a rollout stalls for more than an hour",
      type: "Story",
      status: S.prog,
      assignee: P.me,
      reporter: P.mette,
      parent: epic,
      sprint: "CRM 41",
      description: "Post to #crm-alerts when a rollout makes no progress for an hour.",
      updated: ago(60 * 24 * 5),
    }),
    ticket({
      key: "CE-690",
      summary: "Update cookie banner copy for the NO store",
      type: "Task",
      status: S.todo,
      priority: "Low",
      assignee: P.me,
      reporter: P.priya,
      sprint: "CE 16",
      description: "Legal sent new wording for the Norwegian cookie banner.",
      comments: [comment(P.priya, 60 * 24 * 12, "@Alf legal is asking when this can go out, any update?")],
      updated: ago(60 * 24 * 12),
    }),
    ticket({
      key: "CA-409",
      summary: "Per-store translation settings",
      type: "Story",
      status: S.done,
      assignee: P.me,
      reporter: P.mette,
      parent: epic,
      sprint: "CRM 41",
      description: "Let each store choose which languages it rolls out.",
      resolved: ago(60 * 72),
      updated: ago(60 * 72),
    }),
    ticket({
      key: "CA-421",
      summary: "Dashboard for translation throughput",
      type: "Story",
      status: S.todo,
      priority: "Low",
      reporter: P.mette,
      parent: epic,
      sprint: "Backlog",
      description: "Show languages per hour, failures and retries per store.",
      assignee: P.me,
      updated: ago(60 * 24 * 7 + 60),
    }),
    ticket({
      key: "CE-731",
      summary: "Match app block copy with the web version",
      type: "Story",
      status: S.todo,
      assignee: P.me,
      reporter: P.priya,
      sprint: "CE 18",
      description: "Several app blocks still use old copy. Align the text with the web blocks listed in the content sheet.",
      comments: [comment(P.priya, 110, "Copy sheet is in the description. The checkout blocks matter most.")],
      changes: [{ field: "Assignee", from: "Unassigned", to: "Alf Henderson", author: P.priya, at: ago(120) }],
      updated: ago(120),
    }),
    ticket({
      key: "CE-705",
      summary: "Broken footer links on the DE store",
      type: "Bug",
      status: S.done,
      priority: "Low",
      assignee: P.priya,
      reporter: P.me,
      sprint: "CE 17",
      description: "Three footer links on the DE store return 404.",
      changes: [{ field: "Status", from: "In Review", to: "Done", author: P.priya, at: ago(60 * 26) }],
      updated: ago(60 * 26),
    }),
  ];

  const ev = (kind: EventKind, ticketKey: string, actor: Person, minutesAgo: number, text: string, unread: boolean): InboxEvent => ({
    id: id(),
    kind,
    ticketKey,
    actor,
    at: ago(minutesAgo),
    text,
    unread,
    doneAt: null,
    snoozedUntil: null,
  });

  return {
    me: P.me,
    site: "example.atlassian.net",
    tickets: Object.fromEntries(tickets.map((t) => [t.key, t])),
    events: [
      ev("mention", "CA-418", P.sam, 4, "@Alf do we know the per-account rate limit on the euro store? Batches keep failing around 02:00.", true),
      ev("comment", "CA-412", P.mette, 22, "Can we cap concurrency per store? The DKK account is small and I don't want it hitting limits.", true),
      ev("status", "CA-420", P.jonas, 60, "In Progress → In Review", true),
      ev("assigned", "CE-731", P.priya, 120, "Assigned to you", true),
      ev("field", "CA-400", P.mette, 180, "Due date 10 Oct → 17 Oct", false),
      ev("status", "CE-705", P.priya, 60 * 26, "In Review → Done", false),
      ev("comment", "CA-420", P.jonas, 60 * 20, "Pushed a fix: retries now re-read state before reporting. PR is up.", false),
      ev("comment", "CA-420", P.sam, 38, "Looks good. One question on the retry backoff: is 30s enough for the euro store?", true),
      ev("field", "CA-420", P.jonas, 52, "Priority Medium → High", true),
      ev("comment", "CE-731", P.priya, 110, "Copy sheet is in the description. The checkout blocks matter most.", true),
      { ...ev("mention", "CE-690", P.priya, 60 * 24 * 12, "@Alf legal is asking when this can go out, any update?", false), doneAt: ago(60 * 24 * 11) },
      { ...ev("mention", "CA-400", P.mette, 60 * 50, "@Alf can you confirm the 17 Oct go-live works for the CRM side?", false), doneAt: ago(60 * 49) },
    ],
    watching: ["CA-418", "CA-420", "CE-705", "CA-400"],
    lastSyncAt: new Date().toISOString(),
  };
}

const SIMULATED: [EventKind, string, keyof typeof P, string][] = [
  ["mention", "CE-731", "priya", "@Alf the design is final. The copy sheet is linked in the description, can you start this week?"],
  ["comment", "CA-420", "jonas", "Checks are green. Could you review when you have 10 minutes?"],
];

/** In-memory backend with sample data, used for `pnpm dev` in a browser and until a Jira site is connected. */
export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  private snap = sampleSnapshot();
  private listeners = new Set<(s: Snapshot) => void>();
  private cacheListeners = new Set<(c: CacheChanged) => void>();
  private simulated = 0;

  /** The multi-project tracker behind the cache reads. */
  readonly connector: MockConnector;
  private readonly jiraToken: MockOptions["jiraToken"];

  /** The sample GitHub connection: signed out until a sign-in command runs, unless `githubRepos` is set. */
  readonly github: MockGithub;

  /** `options.catalogSize` sets how many projects there are to choose from; the default is the four sample ones. */
  constructor(options: MockOptions = {}) {
    this.connector = new MockConnector(Date.now(), (c) => this.cacheListeners.forEach((l) => l(c)), options);
    this.github = new MockGithub(options.githubRepos ?? 14, Date.now(), options.githubRepos !== undefined, options.reviewAccess === "none" ? "none" : "sample");
    this.device = options.device ?? { delayMs: 0, outcome: "authorised" };
    this.jiraToken = options.jiraToken;
    if (options.githubProbe) this.github.setProbe(options.githubProbe);
    this.github.onProbeChanged = () => this.connectionsListeners.forEach((l) => l());
    this.runs = new MockRuns(this.proposals, options.runs);
    this.workstreams = new MockWorkstreams(
      () => this.runs.list(),
      (ref) => this.connector.item(ref)?.title ?? null,
    );
    this.runs.workstreams = this.workstreams;
    // A draft made, approved or skipped in a workstream goes in its audit, by whoever did it.
    this.proposals.runRole = (id) => this.runs.get(id)?.spec.role ?? null;
    this.proposals.audit = (p, actor, action, detail, workstream) => void this.workstreams.record(workstream ?? workstreamOf(p), actor, action, { proposalId: p.id, ...(detail ? { detail } : {}) });
    this.workstreams.pendingDrafts = () => this.proposals.list({ states: ["pending"] });
    this.workstreams.moveRun = (id, workstream) => this.runs.setWorkstream(id, workstream);
    this.workstreams.moveDraft = (id, workstream) => this.proposals.setWorkstream(id, workstream);
    // A run that moved on may have moved its workstream's stage on.
    this.runs.onChanged(() => this.workstreams.changed());
    this.runs.ticketText = (ref) => {
      const w = this.connector.item(ref);
      if (!w) return null;
      return ticketBlockText({ item: w, comments: this.connector.comments(ref), people: this.connector.people, titleOf: (r) => this.connector.item(r)?.title ?? null, code: this.github.code.devLinks(ref) });
    };
    this.runs.ticketDoc = (ref) => this.connector.item(ref)?.body ?? null;
    // The sample Pip drafts from a finished report when the sample asks it to. The app does not: a real run waits for Pip.
    const sampleDrafts = typeof options.runs === "object" && !!options.runs?.planDescription;
    if (sampleDrafts) {
      this.runs.onFinished = (run) => this.draftFinished(run);
      for (const run of this.runs.list()) if (run.state === "done" && stepOf(run.spec.role) === "plan") this.draftFinished(run, false);
    }
    this.runs.pullRequest = (repo, number) => this.github.code.change(repo, number);
    this.runs.pullFiles = (repo, number) => this.github.code.pullFiles(repo, number);
    this.runs.codeConnectionFor = (repo) => (this.github.isWatched(repo) ? GITHUB_CONNECTION : null);
    // A draft pull request a build opened turns up on the code host, which ends its workstream's wait for it.
    this.runs.onPullRequest = (change) => this.github.code.addPullRequest(change);
    this.workstreams.prOf = (runId) => this.runs.pullRequestOf(runId);
    this.workstreams.ticketOf = (key) => this.connector.item(itemRef(key));
    // What the person just wrote is the workstream's basis now, so the supervisor doesn't take an approved write for a change.
    this.proposals.onWritten = (p) => {
      const ws = workstreamOf(p);
      if (ws) this.workstreams.rebase(ws, basisFieldsOf(p.intent));
    };
    this.supervisor = new MockSupervisor({
      runs: this.runs,
      workstreams: this.workstreams,
      proposals: this.proposals,
      wake: (ws, facts) => void mockQueueWake(ws, facts, this, options.pipPace),
      cancelWakes: mockCancelWakes,
    });
    exposeMockClock({
      draftReview: (runId, reviewedSha, summary, comments) => { this.draftReview(runId, reviewedSha, summary, comments); },
      runs: this.runs,
      workstreams: this.workstreams,
      proposals: this.proposals,
      pip: { hold: holdMockPip, idle: mockPipIdle },
      tickets: { edit: (key, change) => this.editTicket(key, change) },
      github: { probe: (state) => this.github.setProbe(state), writes: this.github.writes, movePullHead: (repo, number) => this.movePullHead(repo, number), tried: () => this.github.tried, loseNextAnswer: (kept) => this.github.loseNextAnswer(kept) },
    });
    // Drafts Pip made in a conversation live as long as the conversation does, as both live in the app's database.
    this.proposals.keep(KEPT_DRAFTS, (p) => p.origin.type === "chat" && mockPipTurns.has(p.origin.requestId));
  }

  private readonly device: NonNullable<MockOptions["device"]>;
  private readonly connectionsListeners = new Set<() => void>();

  /** Drafts live in memory; `proposals.draft` stands in for the assistant. */
  readonly proposals = new MockProposals(async (intent, already) => {
    if (this.applyToConnector(intent, already)) return this.appliedToConnector;
    switch (intent.type) {
      case "comment":
        await this.comment(intent.item.key, docText(intent.body));
        return [];
      case "transition": {
        const to = Object.keys(S).find((k) => k === intent.to || S[k as keyof typeof S].name === intent.to);
        await this.transition(intent.item.key, `${intent.item.key}:${to}`);
        return [];
      }
      case "subtasks": {
        const rest = intent.summaries.slice(already.length);
        const { created } = await this.createSubtasks(intent.parent.key, rest);
        return created.map((key) => ({ connectionId: "mock", externalId: key, key }));
      }
      case "create":
        return [this.connector.createItem(intent.container, intent.fields)];
      default:
        throw new Error("the sample data can't apply that");
    }
  });

  /** Scripted agent runs, with `advance()` as their clock. */
  readonly runs: MockRuns;

  /** Wakes the scripted Pip in managed workstreams and starts their routine steps, on every change rather than a timer. */
  readonly supervisor: MockSupervisor;

  /** Workstreams, kept in this browser; their stages follow `runs`. */
  readonly workstreams: MockWorkstreams;

  async workstreamsOpen(item: ItemRef | null, title?: string) {
    return this.workstreams.open(item, title ?? null);
  }

  async workstreamsList(includeClosed = false) {
    return this.workstreams.list(includeClosed);
  }

  async workstreamsClose(id: string) {
    const closed = this.workstreams.close(id);
    mockCancelTurns((c) => c === workstreamConversation(id));
    return closed;
  }

  async workstreamsReopen(id: string) {
    return this.workstreams.reopen(id);
  }

  async workstreamsAdopt(id: string) {
    return this.workstreams.adopt(id);
  }

  async workstreamsEvents(id: string) {
    return this.workstreams.events(id);
  }

  /** Pauses a workstream and stops Pip's turns in its conversation, as `workstreams_set_state` with `pause` does; its runs carry on. */
  async workstreamsPause(id: string) {
    const paused = this.workstreams.pause(id, "person", "person");
    mockCancelTurns((c) => c === workstreamConversation(id));
    return paused;
  }

  async workstreamsResume(id: string) {
    return this.workstreams.resume(id);
  }

  async workstreamsDismissAsk(id: string) {
    return this.workstreams.clearAsk(id, "dismissed");
  }

  async workstreamsUndo(id: string, undo: WorkstreamUndo) {
    return this.workstreams.undo(id, undo);
  }

  /** Pauses the workstream, then stops each of its runs that can be stopped, as `stop_workstream` does. */
  async workstreamsStop(id: string) {
    const ws = this.workstreams.pause(id, "person", "person");
    mockCancelTurns((c) => c === workstreamConversation(id));
    const tally = { stopped: 0, failed: 0 };
    for (const run of this.runs.list().filter((r) => r.spec.workstream === ws.id && STOPPABLE.includes(r.state))) {
      try {
        this.runs.stop(run.id);
        tally.stopped += 1;
      } catch {
        tally.failed += 1;
      }
    }
    return tally;
  }

  onWorkstreamsChanged(listener: (c: WorkstreamsChanged) => void) {
    return this.workstreams.onChanged(listener);
  }

  /** The workstream whose conversation the question `requestId` was asked in, as the app reads it from the turn. */
  private workstreamOfRequest(requestId: string): string | null {
    return workstreamOfConversation(mockPipTurns.conversationOf(requestId));
  }

  /** The workstream a draft Pip makes while answering `requestId` belongs to: the conversation's, unless the draft is about another ticket than the workstream's, as `propose` decides. */
  private workstreamOfDraft(requestId: string, intent: Intent): string | null {
    const ws = this.workstreamOfRequest(requestId);
    const target = targetOf(intent);
    if (!ws || !target) return ws;
    return this.workstreams.get(ws)?.workstream.itemKey === target.key ? ws : null;
  }

  runsList(query?: RunQuery) {
    return Promise.resolve(this.runs.list(query));
  }

  async runsStop(id: string) {
    return this.runs.stop(id);
  }

  async runsAnswer(id: string, text: string) {
    return this.runs.answer(id, text);
  }

  async runsAdoptSession(id: string, session: string) {
    return this.runs.adoptSession(id, session);
  }

  async runsStopAll() {
    return this.runs.stopAll();
  }

  async runsAttach(id: string) {
    this.runs.attach(id);
  }

  async runsTrustFolder(id: string) {
    this.runs.trustFolder(id);
  }

  async runsAcceptMode(id: string, mode: "auto" | "bypass") {
    this.runs.acceptMode(id, mode);
  }

  async runsSignIn(id: string) {
    this.runs.signIn(id);
  }

  async runsClones(repo: string) {
    return this.runs.clones(repo);
  }

  async runsCloneFresh(repo: string) {
    return this.runs.cloneFresh(repo);
  }

  async runsPickClone(repo: string, path: string) {
    this.runs.pickClone(repo, path);
  }

  async runsOutcome(id: string) {
    return this.runs.outcome(id);
  }

  async runsEvents(id: string) {
    return this.runs.events(id);
  }

  async runsStartNow(id: string) {
    return this.runs.startNow(id);
  }

  async runsKeepRunning() {
    return this.runs.keepRunning();
  }

  async revealPath(path: string) {
    if (isTauri()) await revealItemInDir(path);
  }

  async runsDisk(id: string) {
    return this.runs.disk(id);
  }

  async runsSettings() {
    return this.runs.settings();
  }

  async setNeedsBadge(_count: number) {}

  async reduceTransparency() {
    return false;
  }

  onConnectionsChanged(listener: () => void) {
    this.connectionsListeners.add(listener);
    return () => void this.connectionsListeners.delete(listener);
  }

  onDisplayChanged(_listener: () => void) {
    return () => {};
  }

  async runsSetSettings(settings: AgentSettings) {
    return this.runs.setSettings(settings);
  }

  async runsCleanup(id: string) {
    return this.runs.cleanup(id);
  }

  async runsArchive(ids: string[]) {
    return this.runs.archive(ids);
  }

  async runsRestore(id: string) {
    this.runs.restore(id);
  }

  async runsClearPreview(filter: ClearFilter) {
    return this.runs.clearPreview(filter);
  }

  async runsClear(filter: ClearFilter) {
    return this.runs.archive(this.runs.clearPreview(filter).ids);
  }

  async runsWorktreeInfo(id: string) {
    return this.runs.worktreeInfo(id);
  }

  async runsDelete(id: string, removeWorktree: boolean) {
    return this.runs.deleteArchived(id, removeWorktree);
  }

  async runsRetryLaunch(id: string) {
    return this.runs.retryLaunch(id);
  }

  onRunsChanged(listener: (c: RunsChanged) => void) {
    return this.runs.onChanged(listener);
  }

  onOpenRun(listener: (runId: string) => void) {
    return this.runs.onOpen(listener);
  }

  proposalsList(query?: ProposalQuery): Promise<Proposal[]> {
    return Promise.resolve(this.proposals.list(query));
  }

  proposalsCreate(intent: Intent, label: string | null = null) {
    return this.proposals.create(intent, label);
  }

  /** Stores a draft the way the assistant would, for the scripted Pip. */
  async pipDraft(intent: Intent, label: string | null, requestId: string) {
    return this.proposals.draft(intent, label, requestId, this.workstreamOfDraft(requestId, intent));
  }

  /** Drafts a text edit the way propose_description_edit does: against the ticket as it reads now, with a sample revision. */
  async pipRewrite(item: ItemRef, part: "title" | "description", requestId: string) {
    const now = this.connector.item(item);
    if (!now) throw new Error(`${item.key} isn't in the sample data`);
    const from = markdownOf(now.body);
    const scope = "## Scope\n- In: what this ticket describes\n- Out: anything it doesn't name";
    const intent: Intent =
      part === "title"
        ? { type: "rewrite", item, title: { from: now.title, to: `${now.title} (scoped)` }, body: null, flattened: [] }
        : { type: "rewrite", item, title: null, body: bodyChange(now.body, from ? `${from}\n\n${scope}` : scope), flattened: [] };
    return this.proposals.draft(intent, null, requestId, this.workstreamOfDraft(requestId, intent));
  }

  pipRuns() {
    return this.runs.list();
  }

  pipDrafts() {
    return this.proposals.list({ states: ["pending"] });
  }

  /**
   * What the sample Pip leaves when `run` finishes: a plan or a thin triage updates the description, a review leaves
   * the sample review, and the For Jira note becomes a comment. `comment` is false for a plan already finished in the
   * sample, which leaves only its description.
   */
  private draftFinished(run: Run, comment = true) {
    if (!run.item) return;
    const step = stepOf(run.spec.role);
    const result = run.result ?? "";
    if (step === "plan") this.draftPlan(run);
    else if (step === "triage" && result.includes("Ready to plan: no")) {
      this.draftTriage(run, result);
      comment = false;
    } else if (step === "review") this.draftSampleReview(run);
    if (comment) this.draftNote(run, result);
  }

  private leftBy(run: Run) {
    return { type: "run" as const, runId: run.id, shortId: run.shortId ?? null, workstream: run.spec.workstream ?? null };
  }

  private keep(intent: Intent, run: Run) {
    const already = this.proposals.list({ states: ["pending"] }).some((p) => p.origin.type === "run" && p.origin.runId === run.id && p.intent.type === intent.type);
    if (already) return;
    try {
      this.proposals.fromRun(intent, run.shortId ? `From agent run ${run.shortId}` : "From an agent run", this.leftBy(run));
    } catch {
      // The description already reads as this plan, so there is nothing to update.
    }
  }

  private draftPlan(run: Run) {
    const body = run.item ? this.connector.item(run.item)?.body : null;
    if (!body) return;
    const made = assemblePlan(run, body, docFromMarkdown);
    if ("problem" in made || markdownOf(made.to) === markdownOf(body)) return;
    this.keep({ type: "rewrite", item: run.item!, title: null, body: bodyChange(body, markdownOf(made.to)), flattened: [] }, run);
  }

  private draftTriage(run: Run, result: string) {
    const body = run.item ? this.connector.item(run.item)?.body : null;
    if (!body) return;
    const note = result.split("\nFor Jira:\n")[1]?.trim() ?? "";
    const questions = (result.split("Open questions:\n")[1]?.split(/\n\n/)[0] ?? "").split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
    const to = withTriageSection(body, note, questions);
    if (markdownOf(to) === markdownOf(body)) return;
    this.keep({ type: "rewrite", item: run.item!, title: null, body: bodyChange(body, markdownOf(to)), flattened: [] }, run);
  }

  private draftSampleReview(run: Run) {
    const { repo, pr, prSha } = run.spec;
    if (!run.item || !pr || !prSha || !this.github.isWatched(repo)) return;
    const files = this.github.code.change(repo, pr)?.sha === prSha ? this.github.code.pullFiles(repo, pr) : null;
    const text = reviewText(SAMPLE_REVIEW_SUMMARY, SAMPLE_REVIEW_COMMENTS, files);
    this.keep({ type: "githubReview", connectionId: GITHUB_CONNECTION, item: run.item, runId: run.id, repo, number: pr, commitSha: prSha, ...text }, run);
  }

  private draftNote(run: Run, result: string) {
    const note = result.split("\nFor Jira:\n")[1]?.trim();
    if (!note || !run.item) return;
    this.keep({ type: "comment", item: run.item, body: docFromText(note) }, run);
  }

  /** Revises a draft the way `revise_proposal` does, from the conversation `requestId` was asked in: a draft of a workstream only from that workstream's. */
  draftReview(runId: string, reviewedSha: string, summary: string, comments: ReviewComment[]) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("that run no longer exists");
    if (!reviewedSha.trim() || !summary.trim()) throw new Error("a review needs its reviewed commit and summary");
    const { repo, pr } = run.spec;
    if (!pr || !this.github.isWatched(repo)) throw new Error("the review needs a watched pull request");
    const files = this.github.code.change(repo, pr)?.sha === reviewedSha ? this.github.code.pullFiles(repo, pr) : null;
    const text = reviewText(summary, comments, files);
    return this.proposals.draft({ type: "githubReview", connectionId: GITHUB_CONNECTION, item: run.item, runId, repo, number: pr, commitSha: reviewedSha, ...text }, "Review from Pip", undefined, run.spec.workstream ?? undefined);
  }

  async pipRevise(id: string, change: string | { body?: string; title?: string; description?: string; summaries?: string[]; comments?: ReviewComment[] }, requestId?: string) {
    const draft = this.proposals.get(id);
    // A review draft's new comments are checked against the pull request's diff at the commit reviewed, which only this
    // backend can read, and only while that commit is still the head, as `Core::diff_at`.
    const files = draft?.intent.type === "githubReview" ? this.reviewedFiles(draft.intent) : null;
    return this.proposals.pipRevise(id, change, requestId ? this.workstreamOfRequest(requestId) : null, files);
  }

  private reviewedFiles(review: Extract<Intent, { type: "githubReview" }>): ChangedFile[] | { unreadable: string } | null {
    if (!this.github.isWatched(review.repo)) return { unreadable: `${review.repo} isn't one of the repositories you watch, so it isn't read.` };
    if (this.github.code.change(review.repo, review.number)?.sha !== review.commitSha) return { unreadable: `the pull request has moved on from ${review.commitSha.slice(0, 8)} since the review read it` };
    return this.github.code.pullFiles(review.repo, review.number);
  }

  pipWorkstreamItem(id: string): ItemRef | null {
    const key = this.workstreams.get(id)?.workstream.itemKey;
    return key ? itemRef(key) : null;
  }

  /** The last time workstream `id`'s ticket changed in Jira, until a wake after the one that follows it: Pip is told once. */
  pipWorkstreamDrift(id: string): LastDrift | null {
    if (!this.workstreams.get(id)) return null;
    const events = this.workstreams.events(id);
    const drift = lastDriftOf(events);
    if (!drift) return null;
    // One wake turn's lines share their time; the turn asking now has written its own already.
    const turns = new Set(events.filter((e) => e.actor === "supervisor" && e.action === "wake" && e.at >= drift.at).map((e) => e.at));
    return turns.size <= 1 ? drift : null;
  }

  pipOpenWorkstream(item: ItemRef | null, title: string) {
    return this.workstreams.open(item, item ? null : title, "pip").id;
  }

  pipStartAgent(workstream: string, role: string, brief: string | null, repo: string | null, pr: number | null, requestId: string) {
    return this.runs.pipStart({ workstream, role, brief, repo, pr, item: this.pipWorkstreamItem(workstream) }, requestId);
  }

  pipPullRequestOf(runId: string) {
    return this.runs.pullRequestOf(runId);
  }

  pipMessageAgent(runId: string, text: string) {
    return this.runs.messageAgent(runId, text);
  }

  pipStopAgent(runId: string) {
    return this.runs.stop(runId, "pip");
  }

  /** The person wrote in workstream `workstream`'s conversation: the question Pip had open there is answered. */
  pipAskAnswered(workstream: string) {
    return this.workstreams.clearAsk(workstream, "answered");
  }

  pipAskPerson(workstream: string, question: string) {
    return this.workstreams.pipAsks(workstream, question);
  }

  pipDrafted(requestId: string) {
    return this.proposals.list().some((p) => p.origin.type === "chat" && p.origin.requestId === requestId);
  }

  proposalsEdit(id: string, edit: ProposalEdit) {
    return this.proposals.edit(id, edit);
  }

  proposalsSkip(id: string) {
    return this.proposals.skip(id);
  }

  proposalsUnskip(id: string) {
    return this.proposals.unskip(id);
  }

  /**
   * Someone edits sample ticket `key` in Jira: its summary, description or status (an id or a name). The cache changes
   * at once (items-changed), and the workstreams tell their listeners, so the supervisor looks again, as a sync bringing
   * the edit would make it.
   */
  editTicket(key: string, change: TicketEdit) {
    this.connector.edit(itemRef(key), { title: change.summary, body: change.description === undefined ? undefined : docFromText(change.description), status: change.statusId });
    this.workstreams.changed();
  }

  proposalsApprove(id: string) {
    return this.proposals.approve(id);
  }

  async proposalsPostReview(id: string, revisions: number, postAnyway = false) {
    return this.proposals.postReview(
      id,
      revisions,
      async (p) => this.github.postReview(p.id, p.intent),
      async (p, sent) => this.github.postedReview(p.intent.repo, p.intent.number, sent.commitSha, sent.summary),
      postAnyway,
    );
  }

  /** Someone force-pushes pull request `number` of `repo`: its head is a new commit whose diff lacks the lines it showed, and the old one is gone from it, as `MockCode.movePullHead`. */
  movePullHead(repo: string, number: number) {
    const moved = this.github.code.movePullHead(repo, number);
    if (moved) {
      this.proposals.touch();
      this.cacheListeners.forEach((l) => l({ connectionId: GITHUB_CONNECTION }));
    }
    return moved;
  }

  onProposalsChanged(listener: (c: ProposalsChanged) => void) {
    return this.proposals.onChanged(listener);
  }

  async load() {
    return this.snap;
  }

  subscribe(listener: (s: Snapshot) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private update(fn: (s: Snapshot) => void) {
    const next = structuredClone(this.snap);
    fn(next);
    this.snap = next;
    this.listeners.forEach((l) => l(next));
    this.cacheListeners.forEach((l) => l({ connectionId: "mock" }));
  }

  /** Puts sample drafts from the assistant on the connector's items. */
  seedSampleDrafts() {
    seedDrafts(this.proposals);
  }

  private appliedToConnector: ItemRef[] = [];

  private applyToConnector(intent: Intent, already: ItemRef[]): boolean {
    const target = targetOf(intent);
    if (!target || !this.connector.has(target)) return false;
    this.appliedToConnector = [];
    switch (intent.type) {
      case "comment":
        this.connector.comment(intent.item, docText(intent.body), intent.body);
        return true;
      case "transition":
        this.connector.transition(intent.item, intent.to);
        return true;
      case "subtasks":
        this.appliedToConnector = this.connector.createSubtasks(intent.parent, intent.summaries.slice(already.length));
        return true;
      case "link":
        this.connector.link(intent.from, intent.to, intent.kind);
        return true;
      case "rewrite": {
        const now = this.connector.item(intent.item)!;
        if ((intent.title && intent.title.from !== now.title) || (intent.body && intent.body.fromText !== markdownOf(now.body))) {
          throw new Error(`${intent.item.key} changed since this was drafted, so nothing was written. Skip this draft and ask Pip to draft it again from the current text.`);
        }
        this.connector.rewrite(intent.item, { title: intent.title?.to, body: intent.body?.to });
        return true;
      }
      default:
        throw new Error("the sample data can't apply that");
    }
  }

  async cacheSearch(filter: WorkFilter, opts: ReadScope = {}) {
    return this.connector.search(filter, opts.includeUnwatched);
  }

  async cacheItem(ref: ItemRef) {
    return this.connector.cacheItem(ref);
  }

  async peekItem(ref: ItemRef) {
    return this.connector.peek(ref) ?? this.pastTicket(ref);
  }

  /**
   * A ticket only a sample run names, such as CA-377 or DEVOPS-455, read the way a live peek reads one the cache doesn't
   * hold: a finished ticket in its project, titled from the run's branch name. Null for any key no run names.
   */
  private pastTicket(ref: ItemRef): WorkItem | null {
    const key = ref.key.toUpperCase();
    const run = this.runs.list().find((r) => r.item?.key.toUpperCase() === key);
    const container = this.connector.listContainers(true).find((c) => c.key === key.slice(0, key.lastIndexOf("-")));
    if (!run?.item || !container) return null;
    const words = run.spec.name.replace(/^[a-z][a-z0-9]*-\d+-/, "").replace(/-[0-9a-f]{4}$/, "").replace(/-/g, " ");
    const at = run.queuedAt;
    return {
      item: itemRef(key),
      container: container.ref,
      kind: "task",
      title: words ? words.charAt(0).toUpperCase() + words.slice(1) : key,
      body: { blocks: [] },
      status: container.workflow.statuses.find((s) => s.category === "done") ?? container.workflow.statuses[0],
      assignee: null,
      reporter: null,
      priority: null,
      parent: null,
      labels: [],
      created: at,
      updated: run.endedAt ?? at,
      links: [],
      commentCount: 0,
      lastCommenter: null,
      extra: null,
      unwatched: !this.connector.listContainers().some((c) => c.key === container.key),
    };
  }

  async cacheContainers(opts: ReadScope = {}) {
    return this.connector.listContainers(opts.includeUnwatched);
  }

  async watchGet(): Promise<WatchState[]> {
    const github = this.github.watchState();
    return github ? [this.connector.watchState(), github] : [this.connector.watchState()];
  }

  async watchSetContainers(connectionId: string, changes: WatchChange[]) {
    if (connectionId === GITHUB_CONNECTION) return this.github.setWatched(changes);
    this.connector.setWatched(changes);
  }

  async watchCatalog(connectionId: string, query: string, cursor: string | null = null): Promise<CatalogPage> {
    if (connectionId === GITHUB_CONNECTION) return this.github.catalogPage(query, cursor);
    return this.connector.catalogPage(query, cursor);
  }

  async watchSuggestions(connectionId?: string): Promise<Footprint[]> {
    if (connectionId === GITHUB_CONNECTION) return this.github.footprint();
    return this.connector.footprint();
  }

  private dismissed = new Set<string>();

  async watchUnwatchedAssigned(connectionId?: string): Promise<Stray[]> {
    if (connectionId === GITHUB_CONNECTION) return [];
    return this.connector.strays().filter((s) => !this.dismissed.has(s.container.externalId));
  }

  async watchDismissAssigned(_connectionId: string, containerId: string) {
    this.dismissed.add(containerId);
  }

  onWatchChanged(listener: (c: WatchChanged) => void) {
    const off = [this.connector.onWatchChanged(listener), this.github.onWatchChanged(listener)];
    return () => off.forEach((f) => f());
  }

  /** The sample data has no background check to run, so nothing is ever announced. */
  onAssignedElsewhere(_listener: (found: AssignedElsewhere) => void) {
    return () => {};
  }

  async cacheEvents(ref: ItemRef) {
    return this.connector.eventsFor(ref);
  }

  async cacheFeed(query: FeedQuery) {
    return this.connector.feed(query);
  }

  async cacheFeedUnread(kinds?: FeedQuery["kinds"]) {
    return this.connector.feedUnread(kinds);
  }

  async cachePeople() {
    return this.connector.people;
  }

  async cacheMe() {
    return this.connector.identity();
  }

  async cacheComments(ref: ItemRef) {
    return this.connector.comments(ref);
  }

  async cacheTransitions(ref: ItemRef) {
    return this.connector.moves(ref);
  }

  async connectionsList(refresh = false): Promise<ConnectionInfo[]> {
    if (refresh) this.github.recheck();
    const refused = this.jiraToken === "refused";
    const status = this.jiraToken ? jiraSnapshot(refused ? "notSignedIn" : "expiresSoon", new Date().toISOString()) : null;
    const sample: ConnectionInfo = { id: MOCK_CONNECTION, instanceId: "jira", displayName: "Sample data", enabled: true, kind: "mock", workspace: "Sample data", url: null, account: PEOPLE.me, lastSyncAt: this.snap.lastSyncAt, syncing: false, error: refused ? "Jira turned down your token. Make a new one to keep syncing" : null, transient: false, reauth: refused, status };
    return this.github.connected ? [sample, this.github.info()] : [sample];
  }

  async devLinks(item: ItemRef) {
    return this.github.code.devLinks(item);
  }

  async devLinksLive(item: ItemRef) {
    return this.github.code.devLinksLive(item);
  }

  onDevLinksChanged(listener: (c: DevLinksChanged) => void) {
    return this.github.code.onDevLinksChanged(listener);
  }

  async codePullRequest(ref: CodeRef) {
    return this.github.code.pullRequest(ref);
  }

  async codePullDiff(_connectionId: string, repo: string, number: number) {
    this.requireWatched(repo);
    const change = this.github.code.change(repo, number);
    if (!change) throw new Error(`GitHub couldn't find pull request #${number} in ${repo}, or the token can't see it.`);
    const files = this.github.code.pullFiles(repo, number);
    if (!files) throw new Error(`GitHub couldn't find pull request #${number} in ${repo}, or the token can't see it.`);
    return { change: { ...change }, files };
  }

  async codeReviewAccess(_connectionId: string, repo: string) {
    this.requireWatched(repo);
    return this.github.reviewAccess(repo);
  }

  /** As `Core::require_watched`: a repository that isn't watched is never read, nor written to. */
  private requireWatched(repo: string) {
    if (!this.github.isWatched(repo)) throw new Error(`${repo} isn't one of the repositories you watch, so it isn't read.`);
  }

  async githubSignInOptions() {
    return this.github.signInOptions();
  }

  async githubConnectToken(token: string) {
    return this.github.connectToken(token);
  }

  async githubImportGhToken() {
    return this.github.importGhToken();
  }

  async githubDeviceStart() {
    return this.github.deviceStart();
  }

  async githubDevicePoll() {
    await new Promise((resolve) => setTimeout(resolve, this.device.delayMs));
    if (this.device.outcome === "denied") throw new Error("access_denied");
    if (this.device.outcome === "expired") throw new Error("the code expired before it was entered; start again");
    return this.github.devicePoll();
  }

  async githubDisconnect(connectionId: string) {
    this.github.disconnect(connectionId);
  }

  onCacheChanged(listener: (c: CacheChanged) => void) {
    this.cacheListeners.add(listener);
    return () => void this.cacheListeners.delete(listener);
  }

  private event(s: Snapshot, eventId: string) {
    const e = s.events.find((x) => x.id === eventId);
    if (!e) throw new Error(`Unknown event ${eventId}`);
    return e;
  }

  async transition(key: string, transitionId: string) {
    const to = S[transitionId.split(":")[1] as keyof typeof S];
    if (!to) throw new Error(`Unknown transition ${transitionId}`);
    this.update((s) => {
      s.tickets[key].status = to;
      s.tickets[key].updated = new Date().toISOString();
    });
  }

  async comment(key: string, body: string) {
    this.update((s) => {
      s.tickets[key].comments.push({ id: id(), author: s.me, created: new Date().toISOString(), body, mentioned: [] });
    });
  }

  private async createSubtasks(key: string, summaries: string[]) {
    const project = key.split("-")[0];
    let next = Math.max(...Object.keys(this.snap.tickets).map((k) => Number(k.split("-")[1]) || 0), 0) + 1;
    const keys = summaries.map(() => `${project}-${next++}`);
    this.update((s) => {
      s.tickets[key].subtasks.push(...summaries.map((summary, i) => ({ key: keys[i], summary, done: false })));
    });
    return { created: keys, error: null };
  }

  async mentionable(_key: string, query: string) {
    const q = fold(query.trim());
    return [...Object.values(P), ...EXTRA_PEOPLE].filter((p) => {
      const name = fold(p.name);
      return name.startsWith(q) || name.split(" ").some((part) => part.startsWith(q));
    });
  }

  async setUnread(eventId: string, unread: boolean) {
    if (this.connector.setRead(eventId, !unread)) return;
    this.update((s) => void (this.event(s, eventId).unread = unread));
  }

  async syncNow() {
    // A sync finds the draft pull requests builds opened.
    this.runs.surfacePullRequests();
    const [kind, key, who, text] = SIMULATED[this.simulated++ % SIMULATED.length];
    this.update((s) => {
      const actor = P[who];
      s.events.push({
        id: id(),
        kind,
        ticketKey: key,
        actor,
        at: new Date().toISOString(),
        text,
        unread: true,
        doneAt: null,
        snoozedUntil: null,
      });
      s.tickets[key].comments.push({ id: id(), author: actor, created: new Date().toISOString(), body: text });
      s.lastSyncAt = new Date().toISOString();
    });
  }

  async openUrl(url: string) {
    if (isTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  }
}
