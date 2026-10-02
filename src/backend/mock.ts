import { isTauri } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AdfNode,
  AssignedElsewhere,
  CacheChanged,
  CatalogPage,
  CodeCommitQuery,
  CodeRef,
  DevLinksChanged,
  FeedQuery,
  Footprint,
  Stray,
  WatchChange,
  WatchChanged,
  WatchMode,
  WatchState,
  ConnectionInfo,
  Comment,
  ContainerRef,
  Intent,
  EventKind,
  InboxEvent,
  ItemRef,
  Person,
  Proposal,
  ProposalEdit,
  ProposalQuery,
  ProposalsChanged,
  RunQuery,
  RunSpec,
  RunsChanged,
  RunsEnabledChange,
  AgentSettings,
  Snapshot,
  Status,
  Ticket,
  Transition,
  Uploaded,
  WorkFilter,
} from "../types";
import { fold, type Mention } from "../lib/mentions";
import { docText } from "../lib/docs";
import { ticketBlockText } from "./mockTicket";
import { MOCK_CONNECTION, MockConnector, PEOPLE, itemRef } from "./mockConnector";
import { targetOf } from "../lib/proposals";
import { MockProposals } from "./mockProposals";
import { MockRuns } from "./mockRuns";
import { seedDrafts } from "./mockDrafts";
import type { MockOptions } from "./mockWatch";
import { GITHUB_CONNECTION, MockGithub } from "./mockGithub";
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

const WORKFLOW: Record<string, [keyof typeof S, string][]> = {
  "To Do": [["prog", "Start progress"], ["blocked", "Block"]],
  "In Progress": [["review", "Send to review"], ["blocked", "Block"], ["todo", "Stop progress"]],
  "In Review": [["done", "Done"], ["prog", "Back to In Progress"]],
  Blocked: [["prog", "Unblock"], ["todo", "Back to To Do"]],
  Done: [["prog", "Reopen"]],
};

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
    activity: [
      { ticketKey: "CA-412", at: ago(60 * 46), kind: "transition", text: "To Do → In Progress" },
      { ticketKey: "CA-409", at: ago(60 * 72), kind: "transition", text: "In Review → Done" },
      { ticketKey: "CA-421", at: ago(60 * 70 + 30), kind: "created", text: "" },
      { ticketKey: "CE-705", at: ago(60 * 96), kind: "transition", text: "In Progress → In Review" },
    ],
    lastSyncAt: new Date().toISOString(),
  };
}

const SIMULATED: [EventKind, string, keyof typeof P, string][] = [
  ["mention", "CE-731", "priya", "@Alf the design is final. The copy sheet is linked in the description, can you start this week?"],
  ["comment", "CA-420", "jonas", "Checks are green. Could you review when you have 10 minutes?"],
];

/** In-memory backend with sample data, used for `pnpm dev` in a browser and until a Jira site is connected. */
/** A rough stand-in for the document Jira builds for a comment with files, so sample mode renders them the same way. */
function withFiles(body: string, files: Uploaded[]): AdfNode {
  const paragraphs: AdfNode[] = body
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }));
  const media = files.map<AdfNode>((f) =>
    f.mimeType.startsWith("image/")
      ? { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: f.mediaId, alt: f.filename } }] }
      : { type: "paragraph", content: [{ type: "text", text: `📎 ${f.filename}` }] },
  );
  return { type: "doc", content: [...paragraphs, ...media] };
}

export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  private snap = sampleSnapshot();
  private listeners = new Set<(s: Snapshot) => void>();
  private cacheListeners = new Set<(c: CacheChanged) => void>();
  private simulated = 0;

  /** The multi-project tracker behind the cache reads; the snapshot above keeps serving the current screens. */
  readonly connector: MockConnector;
  /** The sample GitHub connection: signed out until a sign-in command runs, unless `githubRepos` is set. */
  readonly github: MockGithub;

  /** `options.catalogSize` sets how many projects there are to choose from; the default is the four sample ones. */
  constructor(options: MockOptions = {}) {
    this.connector = new MockConnector(Date.now(), (c) => this.cacheListeners.forEach((l) => l(c)), options);
    this.github = new MockGithub(options.githubRepos ?? 14, Date.now(), options.githubRepos !== undefined);
    this.device = options.device ?? { delayMs: 0, outcome: "authorised" };
    this.runs = new MockRuns(this.proposals, options.runs);
    this.runs.ticketText = (ref) => {
      const w = this.connector.item(ref);
      if (!w) return null;
      return ticketBlockText({ item: w, comments: this.connector.comments(ref), people: this.connector.people, titleOf: (r) => this.connector.item(r)?.title ?? null, code: this.github.code.devLinks(ref) });
    };
    this.runs.pullRequest = (repo, number) => this.github.code.change(repo, number);
    if (this.runs.pipRun) void this.runs.seedPipDraft(itemRef("CA-402"));
  }

  private readonly device: NonNullable<MockOptions["device"]>;

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
      case "startRun":
        throw new Error("A run is approved with its own button");
      default:
        throw new Error("the sample data can't apply that");
    }
  });

  /** Scripted agent runs, with `advance()` as their clock. */
  readonly runs: MockRuns;

  /** Agents are on in the sample build, as the browser build has always shown them. */
  private agentsOn = true;
  /** Makes the next `runsSetEnabled(true)` fail with this reason, as a failed environment capture does. */
  enableFailure: string | null = null;

  async runsEnabled() {
    return this.agentsOn;
  }

  async runsSetEnabled(enabled: boolean): Promise<RunsEnabledChange> {
    if (enabled && !this.agentsOn && this.enableFailure) throw new Error(this.enableFailure);
    this.agentsOn = enabled;
    const keepRunning = this.runs.keepRunning();
    const note =
      enabled || keepRunning === 0
        ? null
        : keepRunning === 1
          ? "1 agent is still running and was not stopped. Gossamr won't start new ones or follow it until you turn Agents back on; it keeps running in Claude."
          : `${keepRunning} agents are still running and were not stopped. Gossamr won't start new ones or follow them until you turn Agents back on; they keep running in Claude.`;
    return { enabled, keepRunning, note };
  }

  runsList(query?: RunQuery) {
    return Promise.resolve(this.runs.list(query));
  }

  async runsGet(id: string) {
    return this.runs.get(id);
  }

  async runsReview(proposalId: string) {
    return this.runs.review(proposalId);
  }

  runsApprove(proposalId: string, digest: string) {
    return this.runs.approve(proposalId, digest);
  }

  async runsStop(id: string) {
    return this.runs.stop(id);
  }

  async runsAnswer(id: string, text: string) {
    return this.runs.answer(id, text);
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

  async runsSignIn(id: string) {
    this.runs.signIn(id);
  }

  async runsPreflight(spec: RunSpec | null) {
    return this.runs.preflight(spec);
  }

  runsDraft(spec: RunSpec, item: ItemRef | null) {
    return this.runs.draft(spec, item);
  }

  async runsRepos() {
    return this.github.watchedRepos();
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

  async runsSuggestName(_clonePath: string, key: string, title: string) {
    return this.runs.suggestName(key, title);
  }

  async runsOutcome(id: string) {
    return this.runs.outcome(id);
  }

  async runsDraftComment(id: string) {
    return this.runs.draftComment(id);
  }

  async runsDraftPlanComment(id: string) {
    return this.runs.draftPlanComment(id);
  }

  async runsRefreshPlan(id: string) {
    return this.runs.refreshPlan(id);
  }

  async runsDraftTicket(id: string) {
    return this.runs.draftTicket(id);
  }

  async runsRepoProject(repo: string) {
    return this.runs.repoProject(repo);
  }

  async runsDraftBlocker(id: string, blockerKey: string) {
    return this.runs.draftBlocker(id, blockerKey);
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

  async runsEnvironment() {
    return this.runs.environment();
  }

  async runsDisk(id: string) {
    return this.runs.disk(id);
  }

  async runsSettings() {
    return this.runs.settings();
  }

  async runsSetSettings(settings: AgentSettings) {
    return this.runs.setSettings(settings);
  }

  async runsCleanup(id: string) {
    return this.runs.cleanup(id);
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

  async proposalsGet(id: string) {
    return this.proposals.get(id);
  }

  proposalsCreate(intent: Intent, label: string | null = null) {
    return this.proposals.create(intent, label);
  }

  /** Stores a draft the way the assistant would, for the scripted Pip. */
  async pipDraft(intent: Intent, label: string | null, requestId: string) {
    return this.proposals.draft(intent, label, requestId);
  }

  pipRuns() {
    return this.runs.list();
  }

  pipDrafts() {
    return this.proposals.list({ states: ["pending"] });
  }

  async pipRevise(id: string, change: string | { body?: string; title?: string; summaries?: string[] }) {
    return this.proposals.pipRevise(id, change);
  }

  pipRunDraft(item: ItemRef, focus: string | null, requestId: string) {
    return this.runs.pipDraft(item, focus, requestId);
  }

  proposalsEdit(id: string, edit: ProposalEdit) {
    return this.proposals.edit(id, edit);
  }

  proposalsSkip(id: string) {
    return this.proposals.skip(id);
  }

  proposalsApprove(id: string) {
    return this.proposals.approve(id);
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
      case "startRun":
        throw new Error("A run is approved with its own button");
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
    return this.connector.peek(ref);
  }

  async cacheContainers(opts: ReadScope = {}) {
    return this.connector.listContainers(opts.includeUnwatched);
  }

  async watchGet(): Promise<WatchState[]> {
    const github = this.github.watchState();
    return github ? [this.connector.watchState(), github] : [this.connector.watchState()];
  }

  async watchSetMode(connectionId: string, mode: WatchMode) {
    if (connectionId === GITHUB_CONNECTION) return this.github.setWatchMode(mode);
    this.connector.setWatchMode(mode);
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

  async cacheWorkflow(container: ContainerRef) {
    return this.connector.workflow(container);
  }

  async cacheEvents(ref: ItemRef) {
    return this.connector.eventsFor(ref);
  }

  async cacheFeed(query: FeedQuery) {
    return this.connector.feed(query);
  }

  async cacheFeedUnread() {
    return this.connector.feedUnread();
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

  async connectionsList(): Promise<ConnectionInfo[]> {
    const sample: ConnectionInfo = { id: MOCK_CONNECTION, kind: "mock", workspace: "Sample data", url: null, account: PEOPLE.me, lastSyncAt: this.snap.lastSyncAt, syncing: false, error: null, transient: false };
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

  async codeSearch(query: string) {
    return this.github.code.search(query);
  }

  async codeEvents(limit?: number) {
    return this.github.code.events(limit);
  }

  async codeFile(_connectionId: string, repo: string, path: string, reference: string | null = null) {
    return this.github.code.file(repo, path, reference);
  }

  async codeTree(_connectionId: string, repo: string, path: string) {
    return this.github.code.tree(repo, path);
  }

  async codeCommits(_connectionId: string, repo: string, opts: CodeCommitQuery = {}) {
    return this.github.code.commits(repo, opts);
  }

  async codeSearchCode(_connectionId: string, query: string, repos?: string[]) {
    return this.github.code.searchCode(query, repos);
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

  async transitions(key: string): Promise<Transition[]> {
    const t = this.snap.tickets[key];
    return (WORKFLOW[t.status.name] ?? []).map(([to, name]) => ({ id: `${key}:${to}`, name, to: S[to] }));
  }

  async transition(key: string, transitionId: string) {
    const to = S[transitionId.split(":")[1] as keyof typeof S];
    if (!to) throw new Error(`Unknown transition ${transitionId}`);
    this.update((s) => {
      s.tickets[key].status = to;
      s.tickets[key].updated = new Date().toISOString();
    });
  }

  async comment(key: string, body: string, mentions: Mention[] = [], files: Uploaded[] = []) {
    const doc = files.length ? withFiles(body, files) : undefined;
    this.update((s) => {
      s.tickets[key].comments.push({ id: id(), author: s.me, created: new Date().toISOString(), body, mentioned: mentions, doc });
    });
  }

  /** Files "uploaded" in sample mode, as object URLs by media id. */
  readonly files = new Map<string, string>();

  async attach(_key: string, file: File): Promise<Uploaded> {
    const mediaId = `sample-${id()}`;
    this.files.set(mediaId, URL.createObjectURL(file));
    return { id: id(), filename: file.name, mimeType: file.type, mediaId };
  }

  dispose() {
    this.files.forEach((url) => URL.revokeObjectURL(url));
    this.files.clear();
  }

  async attachmentLimit() {
    return 10 * 1024 * 1024;
  }

  async ticketMedia() {
    return Object.fromEntries([...this.files.keys()].map((k) => [k, k]));
  }

  attachmentUrl(id: string) {
    return this.files.get(id) ?? "";
  }

  async createSubtasks(key: string, summaries: string[]) {
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

  async markSeen(key: string) {
    if (!this.snap.tickets[key]?.changes.length) return;
    this.update((s) => void (s.tickets[key].changes = []));
  }

  async setUnread(eventId: string, unread: boolean) {
    if (this.connector.setRead(eventId, !unread)) return;
    this.update((s) => void (this.event(s, eventId).unread = unread));
  }

  async setDone(eventId: string, done: boolean) {
    if (this.connector.setRead(eventId, done)) return;
    this.update((s) => {
      const e = this.event(s, eventId);
      e.doneAt = done ? new Date().toISOString() : null;
      if (done) {
        e.unread = false;
        e.snoozedUntil = null;
      }
    });
  }

  async snooze(eventId: string, until: Date | null) {
    this.update((s) => {
      const e = this.event(s, eventId);
      e.snoozedUntil = until?.toISOString() ?? null;
      if (until) e.unread = false;
    });
  }

  async syncNow() {
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
