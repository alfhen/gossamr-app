import { useMemo } from "react";
import type { QueryLookup } from "../lib/filter";
import { queryLookup, useWorkspace } from "../workspaceStore";
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
