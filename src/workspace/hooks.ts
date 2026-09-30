import { useMemo } from "react";
import type { QueryLookup } from "../lib/filter";
import type { WorkFilter } from "../types";
import { itemsByFilter, queryLookup, useWorkspace } from "../workspaceStore";
import { activeTab, useTabs, type Tab } from "./tabsStore";

export function useActiveTab(): Tab {
  return useTabs((s) => activeTab(s));
}

export function useLookup(): QueryLookup {
  const items = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
  const names = useWorkspace((s) => s.names);
  const me = useWorkspace((s) => s.me);
  return useMemo(() => queryLookup({ items, containers, names, me }), [items, containers, names, me]);
}

/** How many items each filter matches, keyed by the index in `filters`, with the project scope applied. */
export function useFilterCounts(filters: readonly WorkFilter[]): number[] {
  const items = useWorkspace((s) => s.items);
  const needsMe = useWorkspace((s) => s.needsMe);
  const me = useWorkspace((s) => s.me);
  const key = JSON.stringify(filters);
  return useMemo(() => filters.map((f) => itemsByFilter({ items, needsMe, me }, f).length), [items, needsMe, me, key]);
}
