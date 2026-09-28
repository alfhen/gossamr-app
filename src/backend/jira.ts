import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Snapshot, Transition } from "../types";
import type { Backend } from "./types";

/** Talks to the Rust core, which syncs Jira into a local SQLite cache and emits a `snapshot` event on every change. */
export class JiraBackend implements Backend {
  readonly kind = "jira" as const;

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
    return invoke<void>("transition", { key, transitionId });
  }

  comment(key: string, body: string) {
    return invoke<void>("comment", { key, body });
  }

  createSubtasks(key: string, summaries: string[]) {
    return invoke<string[]>("create_subtasks", { key, summaries });
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
