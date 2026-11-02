import { useMemo } from "react";
import { usesCode, type QueryLookup } from "../lib/filter";
import type { ItemRef, WorkFilter } from "../types";
import { itemsByFilter, queryLookup, useWorkspace } from "../workspaceStore";
import { useDev } from "./devStore";
import { siteNamer } from "./keyLookup";
import { activeTab, useTabs, type Tab } from "./tabsStore";

export function useActiveTab(): Tab {
  return useTabs((s) => activeTab(s));
}

/** A ticket's site name, once more than one Jira site is on. */
export function useSiteOf(): (ref: ItemRef) => string | null {
  const connections = useWorkspace((s) => s.connections);
  return useMemo(() => siteNamer(connections), [connections]);
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
  const wantsCode = filters.some(usesCode);
  const code = useDev((d) => (wantsCode ? d.index : undefined));
  const key = JSON.stringify(filters);
  return useMemo(() => filters.map((f) => itemsByFilter({ items, needsMe, me, code }, f).length), [items, needsMe, me, code, key]);
}
