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
  kind: "blocks" | "relates" | "duplicates";
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
  | { type: "and"; filters: WorkFilter[] };

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
    | "reviewRequested";
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
  | { type: "subtasks"; parent: ItemRef; summaries: string[] };

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

export type ProposalOrigin = { type: "chat"; requestId: string } | { type: "board" } | { type: "autopilot"; eventId: string };

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
}

/** Which proposals to list. Every field that is set must match. */
export interface ProposalQuery {
  states?: ProposalStateKind[];
  item?: ItemRef;
  connectionId?: string;
}

/** A person's edit to a draft, in the terms the editor works in. */
export type ProposalEdit =
  | { type: "comment"; body: string; mentions: { accountId: string; name: string }[] }
  | { type: "subtasks"; summaries: string[] };

/** Emitted as the `proposals-changed` event when a draft was created, edited, applied, revised or retired. */
export interface ProposalsChanged {
  connectionId: string;
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
  kind: "jira" | "mock";
  /** The site or organisation. */
  workspace: string;
  url: string | null;
  /** The person's name on it. */
  account: string;
  lastSyncAt: string | null;
  syncing: boolean;
  error: string | null;
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

/** A container in the catalog. */
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
