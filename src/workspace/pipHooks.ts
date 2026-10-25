import { useMemo } from "react";
import { itemsByFilter, useItemsByFilter, useWorkspace } from "../workspaceStore";
import { useActivity } from "./activityStore";
import type { Need } from "../lib/needs";
import { useRuns } from "./runsStore";
import { currentNeeds, useNeedsYou } from "./useNeeds";
import { useActiveTab } from "./hooks";
import { useWorkView } from "./workViewStore";
import { buildScreenContext, openWorkstreamLine, type Screen } from "./screenContext";
import { activeTab, useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

const peekedItems = (p: ReturnType<typeof useWorkspace.getState>["peeked"]) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.item]));

type RunsState = ReturnType<typeof useRuns.getState>;

// What needs the person is Needs you's one list: the agents waiting on them are its run needs, and its length is the count the Agents header gives.
const agentsIn = ({ sheet, runs, filters, earlierOpen }: Pick<RunsState, "sheet" | "runs" | "filters" | "earlierOpen">, needs: readonly Need[]): Screen["agents"] => ({ openRun: sheet?.type === "run" ? sheet.id : null, waiting: needs.filter((n) => n.runId).length, needsYou: needs.length, runs, filters, earlierOpen, now: Date.now() });

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
    peeked: peekedItems(ws.peeked),
    containers: ws.containers,
    selected: tabs.selected,
    marked: tabs.marked,
    activity: { chip, container },
    agents: agentsIn(useRuns.getState(), currentNeeds()),
    workstream: openWorkstreamLine(useWorkView.getState().selected, useWorkstreams.getState().list),
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
  const peekedState = useWorkspace((s) => s.peeked);
  const peeked = useMemo(() => peekedItems(peekedState), [peekedState]);
  const selected = useTabs((s) => s.selected);
  const marked = useTabs((s) => s.marked);
  const chip = useActivity((s) => s.chip);
  const container = useActivity((s) => s.container);
  const sheet = useRuns((s) => s.sheet);
  const runs = useRuns((s) => s.runs);
  const filters = useRuns((s) => s.filters);
  const earlierOpen = useRuns((s) => s.earlierOpen);
  const needs = useNeedsYou();
  const agents = useMemo(() => agentsIn({ sheet, runs, filters, earlierOpen }, needs), [sheet, runs, filters, earlierOpen, needs]);
  const openSelected = useWorkView((s) => s.selected);
  const workstream = useWorkstreams((s) => openWorkstreamLine(openSelected, s.list));
  return useMemo(
    () => ({ route, tab, shown, items, peeked, containers, selected, marked, activity: { chip, container }, agents, workstream }),
    [route, tab, shown, items, peeked, containers, selected, marked, chip, container, agents, workstream],
  );
}
