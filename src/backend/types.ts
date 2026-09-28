import type { Mention } from "../lib/mentions";
import type { Person, Snapshot, Transition } from "../types";

export interface Backend {
  readonly kind: "mock" | "jira";
  load(): Promise<Snapshot>;
  /** Called with a fresh snapshot whenever local or remote state changes. Returns an unsubscribe function. */
  subscribe(listener: (snap: Snapshot) => void): () => void;
  transitions(ticketKey: string): Promise<Transition[]>;
  transition(ticketKey: string, transitionId: string): Promise<void>;
  /** Posts a comment. Each mention's `@Name` in the body becomes a real Jira mention, which notifies that person. */
  comment(ticketKey: string, body: string, mentions?: Mention[]): Promise<void>;
  /** People who can see the ticket and match the query, for @mention suggestions. */
  mentionable(ticketKey: string, query: string): Promise<Person[]>;
  /** Creates sub-tasks under a ticket and returns their keys. */
  createSubtasks(ticketKey: string, summaries: string[]): Promise<string[]>;
  markSeen(ticketKey: string): Promise<void>;
  setUnread(eventId: string, unread: boolean): Promise<void>;
  setDone(eventId: string, done: boolean): Promise<void>;
  snooze(eventId: string, until: Date | null): Promise<void>;
  syncNow(): Promise<void>;
  openUrl(url: string): Promise<void>;
}
