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

export interface Comment {
  id: string;
  author: Person;
  created: string;
  body: string;
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
  comments: Comment[];
  /** Changes made by other people since the user last opened the ticket. */
  changes: FieldChange[];
  subtasks: SubtaskRef[];
  /** Keys of issues in this epic; empty for non-epics. */
  children: string[];
  dueDate: string | null;
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
}

export type ViewId = "inbox" | "mentions" | "mine" | "watching" | "snoozed" | "done";
