import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Mention } from "../lib/mentions";
import type {
  CacheChanged,
  ContainerRef,
  Intent,
  ItemRef,
  Person,
  Proposal,
  ProposalEdit,
  ProposalQuery,
  ProposalsChanged,
  Snapshot,
  Transition,
  Uploaded,
  ConnectionInfo,
  WorkComment,
  WorkContainer,
  WorkIdentity,
  WorkMove,
  WorkEvent,
  WorkFilter,
  WorkItem,
  Workflow,
} from "../types";
import type { Backend } from "./types";

/** The Jira site and account this backend acts for. */
export interface Scope {
  cloudId: string;
  accountId: string;
}

/**
 * Talks to the Rust core, which syncs Jira into a local SQLite cache and emits a `snapshot` event on every change.
 * Writes carry `scope`, so a write started for one account is refused if someone else has signed in meanwhile.
 */
export class JiraBackend implements Backend {
  readonly kind = "jira" as const;

  constructor(private readonly scope: Scope) {}

  load() {
    return invoke<Snapshot>("snapshot");
  }

  subscribe(listener: (s: Snapshot) => void) {
    const pending = listen<Snapshot>("snapshot", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  transitions(key: string) {
    return invoke<Transition[]>("transitions", { key });
  }

  transition(key: string, transitionId: string) {
    return invoke<void>("transition", { scope: this.scope, key, transitionId });
  }

  comment(key: string, body: string, mentions: Mention[] = [], files: Uploaded[] = []) {
    return invoke<void>("comment", { scope: this.scope, key, body, mentions, files });
  }

  async attach(key: string, file: File) {
    // The bytes travel as the raw request body; JSON would inflate them several times over.
    const meta = new URLSearchParams({ ...this.scope, key, name: file.name, type: file.type || "application/octet-stream" });
    return invoke<Uploaded>("attach", new Uint8Array(await file.arrayBuffer()), { headers: { "x-file": meta.toString() } });
  }

  ticketMedia(key: string) {
    return invoke<Record<string, string>>("ticket_media", { scope: this.scope, key });
  }

  attachmentUrl(id: string) {
    return convertFileSrc(id, "attachment");
  }

  private limit: Promise<number | null> | null = null;

  attachmentLimit() {
    this.limit ??= invoke<number | null>("attachment_limit", { scope: this.scope }).catch((e) => {
      this.limit = null;
      throw e;
    });
    return this.limit;
  }

  mentionable(key: string, query: string) {
    return invoke<Person[]>("mentionable", { key, query });
  }

  createSubtasks(key: string, summaries: string[]) {
    return invoke<{ created: string[]; error: string | null }>("create_subtasks", { scope: this.scope, key, summaries });
  }

  markSeen(key: string) {
    return invoke<void>("mark_seen", { key });
  }

  setUnread(id: string, unread: boolean) {
    return invoke<void>("set_unread", { id, unread });
  }

  setDone(id: string, done: boolean) {
    return invoke<void>("set_done", { id, done });
  }

  snooze(id: string, until: Date | null) {
    return invoke<void>("snooze", { id, until: until?.toISOString() ?? null });
  }

  cacheSearch(filter: WorkFilter) {
    return invoke<WorkItem[]>("cache_search", { filter });
  }

  cacheItem(item: ItemRef) {
    return invoke<WorkItem | null>("cache_item", { item });
  }

  cacheContainers() {
    return invoke<WorkContainer[]>("cache_containers");
  }

  cacheWorkflow(container: ContainerRef) {
    return invoke<Workflow | null>("cache_workflow", { container });
  }

  cachePeople() {
    return invoke<Person[]>("cache_people");
  }

  cacheMe() {
    return invoke<WorkIdentity>("cache_me");
  }

  cacheComments(item: ItemRef, refresh: boolean) {
    return invoke<WorkComment[]>("cache_comments", { item, refresh });
  }

  cacheTransitions(item: ItemRef) {
    return invoke<WorkMove[]>("cache_transitions", { item });
  }

  connectionsList() {
    return invoke<ConnectionInfo[]>("connections_list");
  }

  cacheEvents(item: ItemRef) {
    return invoke<WorkEvent[]>("cache_events", { item });
  }

  onCacheChanged(listener: (change: CacheChanged) => void) {
    const pending = listen<CacheChanged>("cache-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  proposalsList(query: ProposalQuery = {}) {
    return invoke<Proposal[]>("proposals_list", { query });
  }

  proposalsGet(id: string) {
    return invoke<Proposal | null>("proposals_get", { id });
  }

  proposalsCreate(intent: Intent, label: string | null = null) {
    return invoke<Proposal>("proposals_create", { intent, label });
  }

  proposalsEdit(id: string, edit: ProposalEdit) {
    return invoke<Proposal>("proposals_edit", { id, edit });
  }

  proposalsSkip(id: string) {
    return invoke<Proposal>("proposals_skip", { id });
  }

  proposalsApprove(id: string) {
    return invoke<Proposal>("proposals_approve", { id });
  }

  onProposalsChanged(listener: (change: ProposalsChanged) => void) {
    const pending = listen<ProposalsChanged>("proposals-changed", (e) => listener(e.payload));
    return () => void pending.then((unlisten) => unlisten());
  }

  syncNow() {
    return invoke<void>("sync_now");
  }

  openUrl(url: string) {
    return openUrl(url);
  }
}
