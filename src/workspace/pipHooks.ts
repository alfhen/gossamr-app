import { useMemo } from "react";
import { filterChips } from "../lib/filter";
import { itemsByFilter, useItemsByFilter, useWorkspace } from "../workspaceStore";
import type { WorkItem } from "../types";
import { useActivity } from "./activityStore";
import { useActiveTab } from "./hooks";
import { itemScene, type ItemScene } from "./pipScene";
import { buildScreenContext, type Screen } from "./screenContext";
import { activeTab, useTabs } from "./tabsStore";

/** The screen as it is right now, read when a question is asked so it is about what is on screen then. */
export function readScreen(): Screen {
  const tabs = useTabs.getState();
  const ws = useWorkspace.getState();
  const tab = activeTab(tabs);
  const { chip, container } = useActivity.getState();
  return {
    route: tabs.route,
    tab,
    shown: itemsByFilter(ws, tab.filter),
    items: ws.items,
    containers: ws.containers,
    selected: tabs.selected,
    marked: tabs.marked,
    activity: { chip, container },
  };
}

export const currentContext = () => buildScreenContext(readScreen());

/** The same screen, kept current for rendering. */
export function useScreen(): Screen {
  const route = useTabs((s) => s.route);
  const tab = useActiveTab();
  const shown = useItemsByFilter(tab.filter);
  const items = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
  const selected = useTabs((s) => s.selected);
  const marked = useTabs((s) => s.marked);
  const chip = useActivity((s) => s.chip);
  const container = useActivity((s) => s.container);
  return useMemo(() => ({ route, tab, shown, items, containers, selected, marked, activity: { chip, container } }), [route, tab, shown, items, containers, selected, marked, chip, container]);
}

/** What Pip can tell about the open ticket, or null when none is open on a screen that has a peek. */
export function useItemScene(screen: Screen): ItemScene | null {
  const needsMe = useWorkspace((s) => s.needsMe);
  const names = useWorkspace((s) => s.names);
  const me = useWorkspace((s) => s.me);
  const open = screen.route !== "settings" && screen.selected ? screen.items[screen.selected] : undefined;
  return useMemo(() => (open ? itemScene(open, { items: screen.items, needsMe, names, me, now: Date.now() }) : null), [open, screen.items, needsMe, names, me]);
}

export const unassignedIn = (shown: readonly WorkItem[]) => shown.filter((i) => i.assignee === null && i.status.category !== "done").length;

export const chipCount = (screen: Screen) => filterChips(screen.tab.filter).length;
