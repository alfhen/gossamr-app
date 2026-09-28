import type { Mention } from "../lib/mentions";
import type { Person, Snapshot, Transition, Uploaded } from "../types";

export interface Backend {
  readonly kind: "mock" | "jira";
  load(): Promise<Snapshot>;
  /** Called with a fresh snapshot whenever local or remote state changes. Returns an unsubscribe function. */
  subscribe(listener: (snap: Snapshot) => void): () => void;
  transitions(ticketKey: string): Promise<Transition[]>;
  transition(ticketKey: string, transitionId: string): Promise<void>;
  /** Posts a comment. Each mention's `@Name` in the body becomes a real Jira mention, which notifies that person. */
  comment(ticketKey: string, body: string, mentions?: Mention[], files?: Uploaded[]): Promise<void>;
  /** Uploads a file to the ticket, to be included in a comment. */
  attach(ticketKey: string, file: File): Promise<Uploaded>;
  /** The site's per-file upload limit in bytes, or null when attachments are turned off. */
  attachmentLimit(): Promise<number | null>;
  /** Maps the media ids that documents embed to the ticket's attachment ids. */
  ticketMedia(ticketKey: string): Promise<Record<string, string>>;
  /** A URL the page can load an attachment from. */
  attachmentUrl(attachmentId: string): string;
  /** People who can see the ticket and match the query, for @mention suggestions. */
  mentionable(ticketKey: string, query: string): Promise<Person[]>;
  /** Creates sub-tasks under a ticket and returns their keys. */
  /** Stops at the first failure; `created` lists the keys made before it, in order. */
  createSubtasks(ticketKey: string, summaries: string[]): Promise<{ created: string[]; error: string | null }>;
  markSeen(ticketKey: string): Promise<void>;
  setUnread(eventId: string, unread: boolean): Promise<void>;
  setDone(eventId: string, done: boolean): Promise<void>;
  snooze(eventId: string, until: Date | null): Promise<void>;
  syncNow(): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** Releases anything the backend holds, when the app switches to another one. */
  dispose?(): void;
}
