export type StatusCategory = "new" | "indeterminate" | "done";

export interface Status {
  name: string;
  category: StatusCategory;
}

export interface Person {
  accountId: string;
  name: string;
  avatarUrl?: string | null;
}

/** A node of a Jira document (Atlassian Document Format). */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A file uploaded to a ticket. Without `mediaId` it can't be shown inline, so a comment names it instead. */
export interface Uploaded {
  id: string;
  filename: string;
  mimeType: string;
  mediaId: string | null;
  /** Pixel size, which Jira needs to show an image inline. */
  width?: number;
  height?: number;
}

export interface Comment {
  id: string;
  author: Person;
  created: string;
  body: string;
  /** People @mentioned in the comment, with the name as it appears in `body`. */
  mentioned?: { accountId: string; name: string }[];
  /** The body as Jira's document, when known; `body` is its plain text. */
  doc?: AdfNode | null;
}

export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
  author: Person;
  at: string;
}

export interface SubtaskRef {
  key: string;
  summary: string;
  done: boolean;
}

export interface Ticket {
  key: string;
  summary: string;
  type: string;
  status: Status;
  priority: string | null;
  assignee: Person | null;
  reporter: Person | null;
  parent: { key: string; summary: string } | null;
  description: string;
  descriptionDoc?: AdfNode | null;
  comments: Comment[];
  attachments?: Attachment[];
  /** Changes made by other people since the user last opened the ticket. */
  changes: FieldChange[];
  subtasks: SubtaskRef[];
  /** Keys of issues in this epic; empty for non-epics. */
  children: string[];
  dueDate: string | null;
  /** When the ticket was resolved, if it is and that's known. */
  resolved?: string | null;
  sprint: string | null;
  url: string;
  updated: string;
}

export type EventKind = "mention" | "comment" | "status" | "assigned" | "field";

export interface InboxEvent {
  id: string;
  kind: EventKind;
  ticketKey: string;
  actor: Person;
  at: string;
  text: string;
  unread: boolean;
  doneAt: string | null;
  snoozedUntil: string | null;
}

export interface Transition {
  id: string;
  name: string;
  to: Status;
}

export interface Snapshot {
  me: Person;
  site: string;
  tickets: Record<string, Ticket>;
  events: InboxEvent[];
  watching: string[];
  lastSyncAt: string | null;
  /** Things the user did that the ticket data doesn't show, such as transitions. Their comments are read from the tickets. */
  activity?: MyAction[];
  /** The last sync's error message, cleared by the next successful sync. */
  syncError?: string | null;
}

export type ViewId = "inbox" | "waiting" | "watching" | "snoozed" | "done" | "work";

export interface MyAction {
  ticketKey: string;
  at: string;
  kind: "comment" | "transition" | "created";
  /** The comment, or the transition as "From → To". */
  text: string;
}

/* Connector-neutral model, mirroring src-tauri/src/domain. Names carry a `Work` prefix where they would clash with
   the Jira-shaped types above or with DOM globals. */

export interface ItemRef {
  connectionId: string;
  externalId: string;
  /** For display only; identity is `connectionId` plus `externalId`. */
  key: string;
}

export interface ContainerRef {
  connectionId: string;
  externalId: string;
}

export interface PersonRef {
  connectionId: string;
  accountId: string;
}

export type WorkCategory = "todo" | "active" | "done";

export interface StatusDef {
  id: string;
  name: string;
  category: WorkCategory;
}

export type Transitions = { kind: "any" } | { kind: "graph"; moves: { from: string; to: string }[] };

export interface Workflow {
  statuses: StatusDef[];
  /** Jira only reveals moves per issue, so its graph is empty; ask `transitions` for a real ticket. */
  transitions: Transitions;
}

export interface WorkContainer {
  ref: ContainerRef;
  key: string;
  name: string;
  workflow: Workflow;
}

export type WorkMark = "bold" | "italic" | "strike" | "code";

export type WorkInline =
  | { type: "text"; text: string; marks: WorkMark[] }
  | { type: "link"; href: string; text: string }
  | { type: "mention"; person: PersonRef; name: string }
  | { type: "lineBreak" };

export type WorkBlock =
  | { type: "paragraph"; content: WorkInline[] }
  | { type: "heading"; level: number; content: WorkInline[] }
  | { type: "list"; ordered: boolean; items: WorkBlock[][] }
  | { type: "quote"; content: WorkBlock[] }
  | { type: "code"; language: string | null; text: string }
  | { type: "rule" };

export interface WorkDoc {
  blocks: WorkBlock[];
}

export type WorkItemKind = "task" | "bug" | "story" | "epic";
export type WorkPriority = "lowest" | "low" | "medium" | "high" | "highest";

export interface WorkLink {
  /** `from` blocks, relates to or duplicates `to`. */
  from: ItemRef;
  to: ItemRef;
  kind: "blocks" | "relates" | "duplicates" | "implementedBy";
}

/** A cached item. The tracker's raw payload stays in the backend, so it is always null here. */
export interface WorkItem {
  item: ItemRef;
  container: ContainerRef;
  kind: WorkItemKind;
  title: string;
  body: WorkDoc;
  status: StatusDef;
  assignee: PersonRef | null;
  reporter: PersonRef | null;
  priority: WorkPriority | null;
  parent: ItemRef | null;
  labels: string[];
  created: string;
  updated: string;
  links: WorkLink[];
  commentCount: number;
  lastCommenter: PersonRef | null;
  extra: null;
  /** Set on an item read live from a container that isn't watched. It isn't stored, so it is read-only. */
  unwatched?: boolean;
}

/** The query language for views and search. The backend narrows in SQL and then applies it exactly. */
/** What the person can see when they ask Pip. A page that doesn't know an item's connection sends an empty `connectionId`. */
export interface ScreenContext {
  view: string | null;
  item: ItemRef | null;
  filter: WorkFilter | null;
  selection: ItemRef[];
  /** The agent run open in the run sheet. */
  run?: string | null;
  /** How many agents wait on the person. */
  runsWaiting?: number;
  /** The runs the Agents view lists, by state, such as "1 needs you · 2 running". */
  runsSummary?: string;
}

export type WorkFilter =
  | { type: "needsMe" }
  | { type: "mine" }
  | { type: "unassigned" }
  | { type: "blocked" }
  | { type: "open" }
  | { type: "assignee"; person: PersonRef }
  | { type: "status"; name: string }
  | { type: "category"; category: WorkCategory }
  | { type: "stale"; days: number }
  | { type: "container"; container: ContainerRef }
  | { type: "parent"; item: ItemRef }
  | { type: "label"; label: string }
  | { type: "text"; text: string }
  | { type: "items"; items: ItemRef[] }
  /** Client-only: the backend has no code links in its filter, so this is applied over the cached links and never sent to it. */
  | { type: "code"; check: CodeFilterKind }
  | { type: "and"; filters: WorkFilter[] };

/** `has`/`none`: a linked pull request or not. `open` includes drafts. `failing` looks at open and draft ones. */
export type CodeFilterKind = "has" | "none" | "open" | "merged" | "failing";

export interface WorkEvent {
  id: string;
  connectionId: string;
  at: string;
  kind:
    | "commentAdded"
    | "statusChanged"
    | "assigned"
    | "itemCreated"
    | "prOpened"
    | "prMerged"
    | "checkFailed"
    | "reviewRequested"
    | "prClosed"
    | "prReadyForReview"
    | "reviewSubmitted"
    | "prMentioned"
    | "fieldChanged";
  subject: { type: "item"; item: ItemRef } | { type: "codeChange"; repo: string; number: number };
  actor: PersonRef | null;
  payload: unknown;
}

export interface FeedCursor {
  at: string;
  id: string;
}

/** What a feed shows, mirroring src-tauri/src/domain/event.rs. No kinds means every kind. */
export interface FeedQuery {
  kinds?: WorkEvent["kind"][];
  mentionsOnly?: boolean;
  unreadOnly?: boolean;
  container?: ContainerRef | null;
  /** Also entries about items in containers that aren't watched. */
  includeUnwatched?: boolean;
  before?: FeedCursor | null;
  limit?: number;
}

/** One event about an item, with the state the person has given it. */
export interface FeedEntry {
  id: string;
  connectionId: string;
  at: string;
  kind: WorkEvent["kind"];
  item: ItemRef;
  /** Null once the item has left the cache. */
  itemTitle: string | null;
  actor: PersonRef | null;
  actorName: string | null;
  text: string;
  mention: boolean;
  unread: boolean;
  done: boolean;
}

export interface FeedPage {
  entries: FeedEntry[];
  /** Present when more entries follow. */
  next: FeedCursor | null;
}

/** Emitted as the `cache-changed` event when a sync or a write changed what the cache holds. */
export interface CacheChanged {
  connectionId: string;
}

/** A write drafted for approval, mirroring src-tauri/src/domain/proposal.rs. Only an approval applies it. */
export type Intent =
  | { type: "comment"; item: ItemRef; body: WorkDoc }
  | { type: "transition"; item: ItemRef; to: string }
  | { type: "create"; container: ContainerRef; fields: NewWorkItem; link: WorkLink | null }
  | { type: "update"; item: ItemRef; patch: WorkPatch }
  | { type: "link"; from: ItemRef; to: ItemRef; kind: WorkLink["kind"] }
  | { type: "subtasks"; parent: ItemRef; summaries: string[] }
  /** A new title and/or description, each with the text it was drafted against; an approval refuses when the ticket no longer reads that way. */
  | { type: "rewrite"; item: ItemRef; title: TitleChange | null; body: BodyChange | null; /** What the old description holds that this turns into plain text, such as `tables`. */ flattened: string[] }
  /** Never applied with `proposalsApprove`; `runsApprove` starts it, bound to the digest the person read. */
  | { type: "startRun"; connectionId: string; item: ItemRef | null; spec: RunSpec };

export interface TitleChange {
  from: string;
  to: string;
}

/** A description as it read when drafted and as it would read; the Markdown forms are written by the backend. */
export interface BodyChange {
  from: WorkDoc;
  to: WorkDoc;
  fromText: string;
  toText: string;
}

export interface NewWorkItem {
  title: string;
  body: WorkDoc;
  kind: WorkItemKind;
  assignee: PersonRef | null;
  parent: ItemRef | null;
  priority: WorkPriority | null;
  labels: string[];
}

/** Triage fields; null leaves a field alone. */
export interface WorkPatch {
  assignee: PersonRef | null;
  parent: ItemRef | null;
  priority: WorkPriority | null;
}

export type ProposalOrigin =
  | { type: "chat"; requestId: string }
  | { type: "board" }
  | { type: "autopilot"; eventId: string }
  /** Made by the person from an agent run's result; the text is the agent's. */
  | { type: "run"; runId: string; shortId: string | null };

export type ProposalState =
  | { type: "pending" }
  | { type: "applying" }
  | { type: "applied" }
  | { type: "skipped" }
  | { type: "retired"; reason: string };

export type ProposalStateKind = ProposalState["type"];

export interface ProposalBasis {
  item: ItemRef;
  statusId: string;
  commentCount: number;
  assignee: PersonRef | null;
  parent: ItemRef | null;
  priority: WorkPriority | null;
}

export interface ProposalRevision {
  at: string;
  note: string;
  intent: Intent;
}

export interface Proposal {
  id: string;
  createdAt: string;
  updatedAt: string;
  origin: ProposalOrigin;
  createdBy: "user" | "pip" | "autopilot";
  intent: Intent;
  /** What the approve button says when the intent doesn't (a transition's name). */
  label: string | null;
  basis: ProposalBasis | null;
  state: ProposalState;
  revisions: ProposalRevision[];
  /** Items an attempt created before it stopped; for subtasks, entry `i` belongs to summary `i`. */
  created: ItemRef[];
  /** Why the last attempt to apply it failed. */
  error: string | null;
  /** The run an approved `startRun` became. */
  run: string | null;
}

/** Which proposals to list. Every field that is set must match. */
export interface ProposalQuery {
  states?: ProposalStateKind[];
  item?: ItemRef;
  connectionId?: string;
}

/** A person's edit to a draft, in the terms the editor works in. */
export type ProposalEdit =
  | { type: "comment"; body: string; mentions: { accountId: string; name: string }[]; /** A comment being answered, quoted after the first paragraph. */ quote?: string }
  | { type: "subtasks"; summaries: string[] }
  /** A rewrite's new title and description as Markdown; the ones left out stay as they are. */
  | { type: "rewrite"; title?: string; body?: string }
  /** A new item's fields; the ones left out stay as they are. */
  | { type: "create"; title?: string; body?: string; mentions?: { accountId: string; name: string }[]; kind?: WorkItemKind; container?: ContainerRef }
  /** A run draft's settings, as the person edits them; the ones left out stay as they are. */
  | { type: "run"; instruction?: string; base?: string; clonePath?: string; kind?: RunKind; name?: string; pr?: number | null; allowPush?: boolean; plan?: string; buildAccount?: string; project?: ContainerRef };

/** Emitted as the `proposals-changed` event when a draft was created, edited, applied, revised or retired. */
export interface ProposalsChanged {
  connectionId: string;
}

/** Mirrors src-tauri/src/domain/run.rs. */
export type RunKind = "investigate" | "triage" | "plan" | "build" | "review" | "verify";

/** Everything that decides what an agent does, as the person approves it. */
export interface RunSpec {
  kind: RunKind;
  /** `owner/name`. */
  repo: string;
  clonePath: string;
  base: string;
  /** The worktree folder; with `worktree-` in front it is also the branch. */
  name: string;
  instruction: string;
  /** Pip's note, up to 300 characters, sent as data apart from the instruction. */
  focus?: string | null;
  /** The run whose output led Pip to propose this one. */
  focusFromRun?: string | null;
  /** Snapshot of the ticket made by the backend, never taken from a model. */
  ticketBlock?: string | null;
  /** The pull request a review reads; reviews only. */
  pr?: number | null;
  /** The pull request's head commit when the draft was read; the backend fills it in. */
  prSha?: string | null;
  /** For a build made from a plan run: the plan as the person read and edited it, sent as data apart from the instruction. */
  plan?: string | null;
  /** The plan run it came from. Set with `plan`, builds only. */
  planFromRun?: string | null;
  /** For a review made from a build run: the builder's final answer, sent as data apart from the instruction. */
  buildAccount?: string | null;
  /** The build run it came from. Set with `buildAccount`, reviews only. */
  buildFromRun?: string | null;
  /** Whether a build is told it may push and open a draft pull request. Builds only. */
  allowPush?: boolean;
  /** Where the draft ticket of an investigation with no ticket lands. Its presence makes the run end as a ticket; the agent never chooses it. */
  project?: ContainerRef | null;
}

export type RunState = "queued" | "launching" | "working" | "needsAnswer" | "needsPermission" | "systemBlocked" | "done" | "failed" | "stopped" | "unknown";

/** Why a launch failed, for the failures the person can fix. `Run.error` has the full text. */
export type RunFailure =
  | { type: "untrustedFolder"; path: string }
  | { type: "notSignedIn" }
  | { type: "claudeMissing" }
  | { type: "noClone" }
  | { type: "capReached" }
  | { type: "other" };

export interface Run {
  id: string;
  proposalId: string;
  connectionId: string;
  item: ItemRef | null;
  spec: RunSpec;
  /** What the person read when approving. */
  digest: string;
  expectedWorktree: string;
  state: RunState;
  shortId: string | null;
  sessionId: string | null;
  /** The question, or the exact command awaiting permission. */
  needs: string | null;
  /** The answer Claude proposes to its own question, when it offers one. */
  suggestedReply?: string | null;
  /** An answer that was stopped on its way: the run is stopped, and this is what it was to be woken with. */
  unsentAnswer?: string | null;
  lastDetail: string | null;
  tokens: number | null;
  branch: string | null;
  /** The agent's final answer when `resultComplete`, else only `summary`. */
  result: string | null;
  /** Claude's own one-line summary of the run. */
  summary?: string | null;
  /** Whether `result` is the whole final answer. Absent in sample data, which is always complete. */
  resultComplete?: boolean;
  error: string | null;
  /** Set with `error` when a launch fails; absent for a run that stopped after it started. */
  failure?: RunFailure | null;
  dbFile: string;
  queuedAt: string;
  launchedAt: string | null;
  lastProgressAt: string;
  endedAt: string | null;
  /** Set once `claude rm` has taken the worktree away; the run stays for its result. */
  worktreeRemovedAt?: string | null;
  continuedAt?: string | null;
  /** The ticket made from this run's draft once the person approved it. */
  createdItem?: ItemRef | null;
}

/** Said wherever a result is only the one-line summary Claude keeps, so nobody takes it for the whole answer. */
export const SUMMARY_ONLY = "Gossamr could only read a one-line summary of the run, not its full answer. Open the session to see the rest.";

/** The part of a run's result meant for Jira. Without a `For Jira:` section it is the whole answer, shortened. */
export interface JiraNote {
  text: string;
  fromMarker: boolean;
}

/** The one ticket an investigation with no ticket proposes in its `New ticket:` section. */
export interface TicketProposal {
  title: string;
  kind: WorkItemKind;
  body: string;
}

/** What the run sheet shows about a result: the note, the other tickets it names, and the change the run produced. */
export interface RunOutcome {
  note: JiraNote | null;
  keys: string[];
  change: CodeChange | null;
  /** The comment draft made from this run, in whatever state it is in now. */
  draft: { id: string; state: ProposalState } | null;
  /** For a run with no ticket: what its `New ticket:` section proposes, when it has one. */
  ticket: TicketProposal | null;
  /** The ticket draft made from this run, in whatever state it is in now. */
  ticketDraft: { id: string; state: ProposalState } | null;
  /** For a Triage run on a ticket: the breakdown its `Subtasks:` section proposes. */
  subtasks: string[];
  /** The subtasks draft made from this run, in whatever state it is in now. */
  subtasksDraft: { id: string; state: ProposalState } | null;
  /** The full answer couldn't be read, so `note` is only the one-line summary. */
  summaryOnly?: boolean;
  /** For a Plan run: the draft of the whole plan as a comment, in whatever state it is in now. */
  planDraft?: { id: string; state: ProposalState } | null;
  /** For a Plan run on a ticket: the description update that adds its plan, or why there is none. */
  planDescription?: { draft: { id: string; state: ProposalState } | null; unavailable: string | null } | null;
}

/** The whole plan of a Plan run drafted as a comment, and whether it had to be cut to fit a Jira comment. */
export interface PlanComment {
  proposal: Proposal;
  cut: boolean;
  total: number;
}

/** What the person reads before approving; `digest` is sent back with the approval. */
export interface RunReview {
  digest: string;
  prompt: string;
  instruction: string;
  focus: string | null;
  ticketBlock: string | null;
  /** For a build made from a plan: the plan as it will be sent. */
  plan?: string | null;
  /** For a review made from a build: the builder's account as it will be sent. */
  buildAccount?: string | null;
  guard: string;
  spec: RunSpec;
  /** The reviewed pull request, as GitHub names it now. */
  prTitle?: string | null;
  prUrl?: string | null;
}

/** One line of what the agent did, kept for the run sheet's timeline. */
export interface RunEvent {
  runId: string;
  seq: number;
  at: string;
  kind: string;
  text: string;
  /** Longer text behind the line, shown on request. */
  detail: string | null;
}

/** A local clone of a repository, as found on this Mac. */
export interface LocalClone {
  path: string;
  branch: string;
  dirty: boolean;
  /** What `origin/HEAD` points at, when the clone knows. */
  defaultBranch: string | null;
}

/** What cloning into `~/Gossamr/agents` would do, shown before the person chooses it. */
export interface FreshCopy {
  path: string;
  /** The command Gossamr runs, as a shell would read it. */
  command: string;
  /** `gh` is on the shell's PATH, so a sign-in failure falls back to `gh repo clone`. */
  ghFallback: boolean;
  /** Something that isn't a clone of this repository is already at `path`. */
  occupied: boolean;
}

export interface CloneChoice {
  clones: LocalClone[];
  /** The clone the person chose when several matched; listed first. */
  picked: string | null;
  /** Offered only when there is no clone to choose. */
  fresh: FreshCopy | null;
}

/** Which runs to list. Every field that is set must match. */
export interface RunQuery {
  states?: RunState[];
  item?: ItemRef;
  connectionId?: string;
}

/** Emitted as the `runs-changed` event. */
export interface RunsChanged {
  connectionId: string;
}

/** What the person controls about runs. Zero turns a limit off. */
export interface AgentSettings {
  maxRuns: number;
  wallClockMinutes: number;
  tokenCap: number;
  terminal: "terminal" | "iTerm";
  /** Draft a Jira comment on the run's ticket when it finishes with a `For Jira:` section. */
  draftOnFinish: boolean;
}

/** What `claude rm` said: it removed the worktree, or refused and explained in its own words. */
export type CleanupResult = { type: "removed" } | { type: "refused"; message: string };

/** What `runs_set_enabled` did. `note` says what turning Agents off left alone. */
export interface RunsEnabledChange {
  enabled: boolean;
  keepRunning: number;
  note: string | null;
}

/** One line of a pre-flight check. */
export interface PreflightRow {
  level: "green" | "amber" | "red";
  text: string;
  /** A step the row offers: Terminal in this folder to trust it. */
  action?: { type: "trustFolder"; path: string };
}

export interface Preflight {
  rows: PreflightRow[];
  blocking: boolean;
}

/** Whether Claude Code is there to run agents at all, ahead of any one run. `unknown` when the check could not be made. */
export interface RunsEnvironment {
  claude: "ok" | "missing" | "signedOut" | "unknown";
  version: string | null;
}

/** A comment on a work item, mirroring the domain model. */
export interface WorkComment {
  id: string;
  author: PersonRef;
  body: WorkDoc;
  created: string;
  mentions: PersonRef[];
}

/** The signed-in person across connections. */
export interface WorkIdentity {
  displayName: string;
  accounts: PersonRef[];
}

/** A move open to one item right now, as the tracker offers it. */
export interface WorkMove {
  name: string;
  to: StatusDef;
}

/** A signed-in connection and how its sync is going. */
export interface ConnectionInfo {
  id: string;
  kind: "jira" | "github" | "mock";
  /** The site or organisation; for GitHub, the account's login. */
  workspace: string;
  url: string | null;
  /** The person's name on it. */
  account: string;
  lastSyncAt: string | null;
  syncing: boolean;
  error: string | null;
  /** The error is a network failure the next sync retries; it shows on the row but doesn't raise a toast. */
  transient: boolean;
}

/**
 * What a connection follows, mirroring src-tauri/src/domain/watch.rs. Only watched containers are synced, listed,
 * counted and visible to Pip. `unset` behaves like `everything` until the person chooses.
 */
export type WatchMode = "unset" | "everything" | "selected";

/** `involved`: items the person is on or was mentioned in. `whole`: everything in the container within the sync window. */
export type WatchDepth = "involved" | "whole";

export type WatchSource = "manual" | "footprint" | "auto" | "everything";

/** A catalog this small is watched whole without asking. */
export const AUTO_WATCH_EVERYTHING_MAX = 12;

/** One watched container. A set `unwatchedAt` means it is inside its 14-day grace period and already hidden. */
export interface WatchRow {
  container: ContainerRef;
  depth: WatchDepth;
  pinned: boolean;
  source: WatchSource;
  addedAt: string;
  unwatchedAt: string | null;
  /** The tracker refused it (deleted, or no access); what is cached stays visible. */
  inaccessible: boolean;
  key: string;
  name: string;
  /** Items of it in the local cache. */
  cachedItems: number;
}

export interface WatchState {
  connectionId: string;
  mode: WatchMode;
  /** Nothing is chosen and the catalog is too big to watch whole, so the picker must be shown. */
  needsChoice: boolean;
  /** Containers seen when the catalog was last probed; 13 means "more than 12". */
  catalogSize: number | null;
  watches: WatchRow[];
}

/** One edit to a container's watch; fields left out keep their value. */
export interface WatchChange {
  containerId: string;
  watched?: boolean;
  depth?: WatchDepth;
  pinned?: boolean;
  source?: WatchSource;
}

/**
 * A container in the catalog. For a GitHub repository the key is `owner/name`, the name is the repository's own
 * name and `kind` is the person's permission on it (`admin`, `maintain`, `push`, `triage` or `pull`).
 */
export interface ContainerSummary {
  ref: ContainerRef;
  key: string;
  name: string;
  kind: string | null;
  archived: boolean;
  lastActive: string | null;
  itemHint: number | null;
}

export interface CatalogEntry extends ContainerSummary {
  watched: boolean;
}

export interface CatalogPage {
  containers: CatalogEntry[];
  /** Pass back as the cursor for the next page. */
  next: string | null;
  /** The tracker couldn't be reached; this is what was listed before. */
  offline: boolean;
}

/** How much the person has been involved in one container in the last 90 days. */
export interface Footprint {
  container: ContainerRef;
  key: string;
  name: string;
  assigned: number;
  reported: number;
  watching: number;
  /** Null when the tracker can't count them. */
  commented: number | null;
  mentioned: number | null;
  lastTouch: string | null;
}

/** Open items assigned to the person in a container they don't watch. Suggesting it never watches it. */
export interface Stray {
  container: ContainerRef;
  containerName: string;
  keys: string[];
}

export interface WatchChanged {
  connectionId: string;
}

export interface AssignedElsewhere {
  connectionId: string;
  strays: Stray[];
}

/** Which ways of connecting GitHub work in this build and on this Mac. */
export interface GithubSignInOptions {
  /** A client id is configured, so the browser device flow can be used. */
  deviceFlow: boolean;
  /** The GitHub CLI is installed, so its token can be imported when the person asks. */
  ghCli: boolean;
  /** A pasted personal access token always works. */
  token: boolean;
}

/** The code the person enters at `verificationUri` to authorise the app. The token never reaches the page. */
export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

// ---- Code hosting (GitHub), mirroring src-tauri/src/domain/code.rs ----

export type CodeChangeKind = "pullRequest" | "branch" | "commit";

/** Only pull requests move through every state. A branch is `open` while it exists; a commit on the default branch is `merged`. */
export type CodeChangeState = "draft" | "open" | "merged" | "closed";

export type CheckState = "none" | "pending" | "passing" | "failing";

export type ReviewState = "none" | "requested" | "approved" | "changesRequested" | "commented";

/** A pull request, a branch or a commit. */
export interface CodeChange {
  connectionId: string;
  /** `pr:acme/webshop#12`, `branch:acme/webshop:ca-208-gateway` or `commit:acme/webshop@<sha>`. */
  externalId: string;
  kind: CodeChangeKind;
  /** `owner/name`. */
  repo: string;
  number: number | null;
  /** A pull request's title, a branch's name, or a commit's first line. */
  title: string;
  /** The head branch of a pull request, the name of a branch, or the branch a commit was read from. */
  headRef: string;
  baseRef: string | null;
  /** The repository a pull request's head branch lives in: another one for a fork. Unknown for older cached rows. */
  headRepo?: string | null;
  state: CodeChangeState;
  mergedAt: string | null;
  createdAt: string | null;
  updatedAt: string;
  author: PersonRef | null;
  reviewers: PersonRef[];
  checks: CheckState;
  review: ReviewState;
  url: string;
  sha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** A pull request's description or the rest of a commit message, cut at 2000 characters. */
  body: string;
  /** Work item keys found in the branch, title, body or message. */
  linkedKeys: string[];
}

/** Where in a change a work item's key was found. */
export type LinkSource = "branch" | "title" | "commit" | "body";

/** A work item and the code change that carries it out. Strongest (`confidence`) first. */
export interface DevLink {
  item: ItemRef;
  change: CodeChange;
  provenance: LinkSource;
  /** 0.95 branch, 0.9 title, 0.85 commit message, 0.6 description. */
  confidence: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Cut short at 4000 characters; absent for binary files and very large diffs. */
  patch: string | null;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string | null;
  at: string;
  url: string;
}

export interface ReviewInfo {
  id: string;
  reviewer: PersonRef;
  state: ReviewState;
  at: string | null;
}

export interface PullRequestDetail {
  change: CodeChange;
  files: ChangedFile[];
  /** More files changed than were listed. */
  filesTruncated: boolean;
  /** The latest 30, oldest first. */
  commits: CommitInfo[];
  reviews: ReviewInfo[];
}

/** Names a pull request to read in full. */
export interface CodeRef {
  connectionId: string;
  repo: string;
  number: number;
}

export interface CodeFile {
  repo: string;
  path: string;
  /** The ref asked for; empty for the default branch. */
  reference: string;
  text: string;
  /** Bytes of the whole file, which may be more than `text` holds. */
  size: number;
  /** `text` is cut at 60,000 characters. */
  truncated: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "submodule";
  size: number;
}

export interface CodeHit {
  repo: string;
  path: string;
  url: string;
  fragments: string[];
}

export interface CodeCommitQuery {
  /** A branch, tag or commit; the default branch when absent. */
  reference?: string | null;
  /** RFC 3339. */
  since?: string | null;
  /** Only commits whose message contains this, ignoring case, such as a ticket key. */
  query?: string | null;
  limit?: number;
}

/** Emitted as `dev-links-changed` when a sync or a live search changed which work items are linked to code. */
export interface DevLinksChanged {
  connectionId: string;
}
