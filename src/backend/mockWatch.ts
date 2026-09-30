import { AUTO_WATCH_EVERYTHING_MAX, type ContainerRef, type WatchChange, type WatchMode, type WatchRow, type WatchState } from "../types";

export interface MockOptions {
  /** How many projects the catalog lists, at least the four that hold sample items. Above 12 the choice of what to watch starts unset. */
  catalogSize?: number;
}

interface Stored {
  depth: WatchRow["depth"];
  pinned: boolean;
  source: WatchRow["source"];
  addedAt: string;
  unwatchedAt: string | null;
  inaccessible: boolean;
}

/** What a connection follows, kept the way the backend keeps it: a mode and rows that are soft-unwatched rather than removed. */
export class MockWatch {
  mode: WatchMode;
  private rows = new Map<string, Stored>();

  constructor(
    private readonly connectionId: string,
    readonly catalogSize: number,
  ) {
    this.mode = catalogSize <= AUTO_WATCH_EVERYTHING_MAX ? "everything" : "unset";
  }

  /** Ids of the containers that may be shown, or null when every one may. */
  visible(): Set<string> | null {
    if (this.mode !== "selected") return null;
    return new Set([...this.rows].filter(([, r]) => r.unwatchedAt === null).map(([id]) => id));
  }

  isWatched(containerId: string): boolean {
    return this.visible()?.has(containerId) ?? true;
  }

  setMode(mode: WatchMode) {
    this.mode = mode;
  }

  apply(changes: WatchChange[], at = new Date().toISOString()) {
    const selected = this.mode === "selected";
    for (const c of changes) {
      const row = this.rows.get(c.containerId);
      if (c.watched === false) {
        if (row && row.unwatchedAt === null) row.unwatchedAt = at;
        continue;
      }
      if (!row) {
        if (selected && c.watched !== true) continue;
        this.rows.set(c.containerId, {
          depth: c.depth ?? "involved",
          pinned: c.pinned ?? false,
          source: c.source ?? (selected ? "manual" : "everything"),
          addedAt: at,
          unwatchedAt: null,
          inaccessible: false,
        });
        continue;
      }
      if (c.watched === true) row.unwatchedAt = null;
      row.depth = c.depth ?? row.depth;
      row.pinned = c.pinned ?? row.pinned;
      row.source = c.source ?? row.source;
    }
  }

  state(describe: (id: string) => { key: string; name: string; cachedItems: number }): WatchState {
    const watches: WatchRow[] = [...this.rows].map(([id, r]) => {
      const container: ContainerRef = { connectionId: this.connectionId, externalId: id };
      return { container, ...r, ...describe(id) };
    });
    return {
      connectionId: this.connectionId,
      mode: this.mode,
      needsChoice: this.mode === "unset" && this.catalogSize > AUTO_WATCH_EVERYTHING_MAX,
      catalogSize: Math.min(this.catalogSize, AUTO_WATCH_EVERYTHING_MAX + 1),
      watches,
    };
  }
}
