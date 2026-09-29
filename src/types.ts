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
}

/** The query language for views and search. The backend narrows in SQL and then applies it exactly. */
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

/** Emitted as the `cache-changed` event when a sync or a write changed what the cache holds. */
export interface CacheChanged {
  connectionId: string;
}
