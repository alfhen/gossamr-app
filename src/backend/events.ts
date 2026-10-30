import { listen } from "@tauri-apps/api/event";
import type { Stray } from "../types";

/** The only events Rust sends (`src-tauri/src/wire.rs`); the page listens to nothing else. */
export const EVENTS = {
  changed: "changed",
  pip: "pip",
  snapshot: "snapshot",
  openRun: "open-run",
} as const;

/** What a `changed` event says changed. */
export type Topic = "cache" | "proposals" | "runs" | "workstreams" | "watch" | "devLinks" | "assignedElsewhere" | "display";

export interface Changed {
  topic: Topic;
  connectionId: string;
  /** With `assignedElsewhere`: the open items assigned to the person in containers they don't watch. */
  strays?: Stray[];
}

/** Calls `listener` for each `changed` event of `topic`. Returns an unsubscribe function. */
export function onChanged(topic: Topic, listener: (change: Changed) => void): () => void {
  const pending = listen<Changed>(EVENTS.changed, (e) => {
    if (e.payload.topic === topic) listener(e.payload);
  });
  return () => void pending.then((unlisten) => unlisten());
}
