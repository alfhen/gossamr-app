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
