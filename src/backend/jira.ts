import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Mention } from "../lib/mentions";
import type { Person, Snapshot, Transition, Uploaded } from "../types";
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

  syncNow() {
    return invoke<void>("sync_now");
  }

  openUrl(url: string) {
    return openUrl(url);
  }
}
