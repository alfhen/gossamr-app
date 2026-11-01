import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PipGlyph } from "../components/PipGlyph";
import { ALL, containerKey, itemKey } from "../lib/filter";
import type { CatalogEntry, ContainerRef, WorkContainer, WorkItem } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import { currentNeeds, useNeedsYou } from "./useNeeds";
import { openNeed } from "./needsActions";
import { askPip } from "./askPip";
import { useToasts } from "./toasts";
import { unwatchWithUndo } from "./unwatch";
import { useActivity } from "./activityStore";
import { buildCommands, askToPlanCommands, workstreamCommands, keyCommand, newTicketIntent, projectChoices, pullCommand, rankCommands, searchOrder, ticketCommands, unwatchCommands, watchCommands, withAskPip, PIP_ICON, type Command, type CommandActions, type CommandContext } from "./commands";
import { workContainers } from "./domains";
import { projectOf, withProject } from "./filters";
import { usePrefs } from "./prefs";
import { useRuns } from "./runsStore";
import { activeTab, allSavedViews, useTabs } from "./tabsStore";
import { openTicketByKey } from "./jump";
import { focusPeekOf } from "./PeekSheet";
import { useGithubUi } from "./githubUi";
import { useJiraUi } from "./jiraUi";
import { openPull } from "./openPull";
import { openOnAgents, togglePip, useWorkstreams } from "./workstreamsStore";
import { contextEntries, focusedSubject } from "./contextActions";
import { undoLog } from "./undo";
import { showAllRuns } from "./TimelineFilterBar";

/** Where focus lands when the palette closes and the element that opened it is gone. */
export const MAIN_ID = "workspace-main";

const KBD = "rounded border border-ws-sep2 bg-ws-win px-1 font-sans text-[11px] font-medium";

/** The palette's placeholder when it is a plain search, and the input's name then. */
export const DEFAULT_PLACEHOLDER = "Switch project, change view, jump to a ticket, or ask Pip…";
export const SEARCH_NAME = "Search commands and tickets";

/** The input's accessible name: the question a mode asks ("Which ticket should the agent work on?"), since the placeholder alone is not reliably read; plain search keeps its name (G9). */
export const inputName = (placeholder: string) => (placeholder === DEFAULT_PLACEHOLDER ? SEARCH_NAME : placeholder.replace(/…$/, ""));

/**
 * Where the keyboard goes when the palette closes: back to what had it, else the main area. Left alone when it already
 * moved on to something on the page (a view the pick opened took it), which this would otherwise take back.
 */
export function restoreFocus(opener: HTMLElement | null, doc: Pick<Document, "activeElement" | "body" | "getElementById"> = document): void {
  const at = doc.activeElement as HTMLElement | null;
  if (at && at !== doc.body && at.isConnected) return;
  (opener?.isConnected ? opener : doc.getElementById(MAIN_ID))?.focus();
}

export function PaletteView({
  query,
  results,
  active,
  placeholder = DEFAULT_PLACEHOLDER,
  empty,
  hints = ["↑↓ move", "↵ select", "esc close"],
  onQuery,
  onActive,
  onRun,
  onClose,
}: {
  query: string;
  results: Command[];
  active: number;
  placeholder?: string;
  /** Shown instead of "Nothing matches" when there are no results. */
  empty?: string;
  /** Key hints for the footer, each "key label". */
  hints?: string[];
  onQuery(q: string): void;
  onActive(i: number): void;
  onRun(c: Command): void;
  onClose(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    document.getElementById(`palette-${results[active]?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const onKeyDown = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "ArrowDown":
      case "ArrowUp": {
        ev.preventDefault();
        if (results.length) onActive((active + (ev.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
        return;
      }
      case "Enter":
        ev.preventDefault();
        if (results[active]) onRun(results[active]);
        return;
      case "Escape":
        ev.preventDefault();
        onClose();
        return;
      case "Tab":
        // The input is the only stop, so focus can't leave the dialog.
        ev.preventDefault();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/15 pt-[12vh]" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown} className="ws-pop ws-glass ws-glass-regular relative w-[min(560px,92vw)] overflow-hidden rounded-[14px]">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
          aria-label={inputName(placeholder)}
          placeholder={placeholder}
          value={query}
          onChange={(ev) => onQuery(ev.target.value)}
          className="w-full border-b border-ws-sep bg-ws-win px-4 py-3.5 text-[15px] outline-none placeholder:text-ws-ink2"
        />
        <ul id="palette-list" role="listbox" aria-label="Results" className="m-0 max-h-[min(380px,50vh)] list-none overflow-auto p-1.5">
          {results.map((c, i) => (
            <Fragment key={c.id}>
              {c.group !== results[i - 1]?.group && (
                <li role="presentation" className="px-2.5 pt-2 pb-0.5 text-sm font-semibold text-ws-ink2">
                  {c.group}
                </li>
              )}
              <li
                id={`palette-${c.id}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => i !== active && onActive(i)}
                // An option can't take focus; the press must not pull it off the input either, or it falls to the page.
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => onRun(c)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] ${i === active ? "ws-glass-lens" : ""}`}
              >
                <span aria-hidden className={`w-4 shrink-0 text-center ${c.group === "Ask Pip" ? "text-ws-pip" : "text-ws-ink2"}`}>
                  {c.icon === PIP_ICON ? <PipGlyph /> : (c.icon ?? "·")}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{c.label}</span>
                {c.hint && <span className="shrink-0 text-xs font-medium text-ws-ink">{c.hint}</span>}
              </li>
            </Fragment>
          ))}
          {!results.length && <li role="presentation" className="px-3 py-3 font-medium text-ws-ink">{empty ?? `Nothing matches “${query}”.`}</li>}
        </ul>
        <div className="flex gap-3.5 border-t border-ws-sep px-3.5 py-2 text-xs font-medium text-ws-ink">
          {hints.map((h) => {
            const [key, ...label] = h.split(" ");
            return (
              <span key={h}>
                <kbd className={KBD}>{key}</kbd> {label.join(" ")}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Narrows the active tab to the item's project unless its filter already shows the item, then selects it. */
export function jumpToItem(item: WorkItem) {
  const tabs = useTabs.getState();
  const tab = activeTab(tabs);
  const shown = itemsByFilter(useWorkspace.getState(), tab.filter).some((i) => itemKey(i.item) === itemKey(item.item));
  if (!shown) tabs.setFilter(withProject(ALL, item.container));
  tabs.setRoute("workspace");
  tabs.select(itemKey(item.item));
}

/** The synced ticket the peek shows, the one a workstream can be started on; an unsynced one is read-only. */
function peekedTicket(): WorkItem | null {
  const { selected, route, marked } = useTabs.getState();
  if (!selected || route === "settings" || marked.length > 1) return null;
  return useWorkspace.getState().items[selected] ?? null;
}

export function appActions(): CommandActions {
  const tabs = useTabs.getState();
  const prefs = usePrefs.getState();
  return {
    goToProject: tabs.setProject,
    openSavedView: tabs.openSavedView,
    setView: tabs.setView,
    addFilter: (f) => (tabs.setRoute("workspace"), tabs.addFilter(f)),
    clearFilters: () => tabs.setFilter({ type: "and", filters: [] }),
    setTheme: prefs.setTheme,
    openSettings: () => tabs.setRoute("settings"),
    manageProjects: () => tabs.openSettings("watching"),
    watch: (target, watched) => {
      if (!watched) return void unwatchWithUndo(target.ref, target.name);
      const ws = useWorkspace.getState();
      ws.watchContainers(target.ref.connectionId, [{ containerId: target.ref.externalId, watched: true, source: "manual" }]).then(
        () => useToasts.getState().push(`Watching ${target.name}.`, "info"),
        (e) => ws.report(`Couldn't watch ${target.name}`, e),
      );
    },
    // A ticket opened from here takes the keyboard into its peek, not back to the board behind it.
    openTicket: (key) => void openTicketByKey(key).then((shown) => shown && focusPeekOf(key)),
    openActivity: () => tabs.setRoute("activity"),
    openDrafts: () => {
      const draft = currentNeeds().find((need) => need.target.type === "draft");
      if (draft) openNeed(draft);
      else (tabs.setRoute("agents"), useRuns.getState().setFilter({ needs: true }));
    },
    addGithub: () => useGithubUi.getState().openConnect(),
    addJira: () => useJiraUi.getState().openConnect(),
    manageRepositories: () => tabs.openSettings("watching"),
    openPull: (ref) => void openPull(ref),
    newTab: () => void tabs.openTab(),
    newTicket: () => {},
    togglePip,
    showNeedsYou: () => {
      // Agents with the Needs you filter on and the most urgent need open; with nothing waiting, just Agents.
      useRuns.setState({ sheet: null });
      const first = currentNeeds()[0];
      if (first) openNeed(first);
      else tabs.setRoute("agents");
    },
    openAgentSafety: () => {
      tabs.setRoute("agents");
      useRuns.getState().openSafety();
    },
    startWorkstream: () => {
      const ticket = peekedTicket();
      if (ticket) void useWorkstreams.getState().start(ticket.item);
    },
    closeWorkstream: () => {
      const ticket = peekedTicket();
      const open = ticket ? useWorkstreams.getState().forItem(ticket.item.key, ticket.item.connectionId) : null;
      if (open) useWorkstreams.getState().askClose(open.workstream.id);
    },
    jumpToItem: (item) => {
      jumpToItem(item);
      focusPeekOf(item.item.key);
    },
    askPip,
    openAgents: showAllRuns,
    openWorkstream: openOnAgents,
    askPipToPlan: (item) => void askPipToPlan(item),
  };
}

/**
 * The palette's "Ask Pip to plan KEY": opens or finds the workstream on the ticket (as the peek's Ask Pip does), shows it
 * on Agents and asks Pip to plan it.
 */
export async function askPipToPlan(item: WorkItem) {
  useTabs.getState().setRoute("agents");
  const ws = await useWorkstreams.getState().start(item.item);
  if (!ws) return;
  openOnAgents(ws.workstream.id);
  askPip(`plan ${item.item.key}`);
}

/** "Undo: Skipped the draft on CA-401." for the newest action still good to undo, for a keyboard that missed the toast. */
function undoEntries(): Command[] {
  const last = undoLog.latest();
  return last ? [{ id: "undo:last", group: "App", icon: "↶", label: `Undo: ${last.text}`, hint: "put it back", keywords: "undo put back restore take back", run: () => void undoLog.run(last.id) }] : [];
}

/** What the palette asks: anything, or a new ticket's project, then its title. */
type Step = { type: "search" } | { type: "project" } | { type: "title"; container: WorkContainer };

const currentProject = (): ContainerRef | null => {
  const f = activeTab(useTabs.getState()).filter;
  return projectOf(f) ?? null;
};

async function draftTicket(container: WorkContainer, title: string) {
  const { backend } = useWorkspace.getState();
  if (!backend) return useToasts.getState().push("Not connected yet.");
  try {
    await backend.proposalsCreate(newTicketIntent(container.ref, title));
    await useWorkspace.getState().refreshProposals();
    useToasts.getState().push(`Drafted a new ticket in ${container.name}.`, "info");
    appActions().openDrafts();
  } catch (e) {
    useToasts.getState().push(e instanceof Error ? e.message : String(e));
  }
}

/** Containers matching the query that the person doesn't watch, searched on the server. */
function useUnwatchedMatches(query: string, enabled: boolean): CatalogEntry[] {
  const backend = useWorkspace((s) => s.backend);
  const selectedModes = useWorkspace((s) => s.watch.filter((w) => w.chosen).map((w) => w.connectionId).join(","));
  const [hits, setHits] = useState<CatalogEntry[]>([]);
  const q = query.trim();
  useEffect(() => {
    if (!enabled || !backend || !selectedModes || q.length < 2) return setHits([]);
    let current = true;
    setHits([]);
    const timer = setTimeout(() => {
      Promise.all(selectedModes.split(",").map((id) => backend.watchCatalog(id, q).then((p) => p.containers, () => [] as CatalogEntry[]))).then(
        (pages) => current && setHits(pages.flat().filter((e) => !e.watched)),
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [backend, selectedModes, q, enabled]);
  return hits;
}

export function Palette() {
  const close = usePrefs((s) => s.setPaletteOpen);
  const containers = useWorkspace((s) => s.containers);
  const items = useWorkspace((s) => s.items);
  const watch = useWorkspace((s) => s.watch);
  const proposals = useWorkspace((s) => s.proposals);
  const github = useWorkspace((s) => s.connections.some((c) => c.kind === "github"));
  const jira = useWorkspace((s) => s.connections.some((c) => c.kind === "jira"));
  const unread = useActivity((s) => s.unread);
  const needingMe = useNeedsYou().length;
  const savedViews = useTabs((s) => s.savedViews);
  const selected = useTabs((s) => s.selected);
  const workstreams = useWorkstreams((s) => s.list);
  const tab = useTabs((s) => activeTab(s));
  // Opened to do one thing, the search starts with its words.
  const [query, setQuery] = useState(() => usePrefs.getState().paletteSeed);
  const [active, setActive] = useState(0);
  const [step, setStep] = useState<Step>({ type: "search" });
  const unwatched = useUnwatchedMatches(query, step.type === "search");

  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // What the keyboard was on when the palette opened: its entries act on that item, as its buttons do.
  const [subject] = useState(() => focusedSubject(document.activeElement));

  useEffect(() => () => restoreFocus(opener), [opener]);

  const go = (next: Step) => (setStep(next), setQuery(""), setActive(0));

  const results = useMemo(() => {
    const sorted = workContainers(Object.values(containers)).sort((a, b) => containerKey(a.ref).localeCompare(containerKey(b.ref)));
    if (step.type === "project") return projectChoices(sorted, query, currentProject(), (c) => go({ type: "title", container: c }));
    if (step.type === "title") {
      const title = query.trim();
      const { container } = step;
      return title ? [{ id: "new:create", group: "Create" as const, icon: "＋", label: `Draft “${title}” in ${container.name}`, hint: "↵", run: () => void draftTicket(container, title) }] : [];
    }
    const actions = { ...appActions(), newTicket: () => go({ type: "project" }) };
    const ticket = peekedTicket();
    const ctx: CommandContext = {
      project: projectOf(tab.filter) ?? null,
      view: tab.view,
      unreadActivity: unread,
      github,
      jira,
      needsYou: needingMe,
      ticket: ticket ? { key: ticket.item.key, workstream: !!useWorkstreams.getState().forItem(ticket.item.key, ticket.item.connectionId) } : null,
      onAgents: useTabs.getState().route === "agents",
    };
    const commands = buildCommands(sorted, allSavedViews({ savedViews }), actions, ctx);
    const all = Object.values(items);
    const tickets = ticketCommands(all, query, actions.jumpToItem);
    // A typed ticket key stays first; any other ticket comes after the commands the query names ("runs", "agents").
    const ranked = rankCommands([...contextEntries(subject), ...undoEntries(), ...commands, ...unwatchCommands(sorted.filter((c) => watch.find((w) => w.connectionId === c.ref.connectionId)?.chosen), query, actions)], query);
    const order = searchOrder(tickets, ranked, query);
    const found = [
      ...order.head,
      ...order.tickets,
      ...keyCommand(query, all, actions.openTicket),
      ...pullCommand(query, actions.openPull),
      ...askToPlanCommands(all, query, actions),
      ...workstreamCommands(workstreams, query, actions),
      ...order.commands,
      ...watchCommands(unwatched.map((e) => ({ ref: e.ref, key: e.key, name: e.name })), actions),
    ];
    return withAskPip(found, query, actions.askPip);
  }, [containers, items, watch, proposals, github, jira, unread, needingMe, savedViews, tab.filter, tab.view, query, step, unwatched, selected, workstreams, subject]);

  // A new ticket's project and title are steps back to the search.
  const prompting = step.type === "project" || step.type === "title";
  return (
    <PaletteView
      query={query}
      results={results}
      active={Math.min(active, Math.max(0, results.length - 1))}
      placeholder={step.type === "project" ? "Which project is the ticket for?" : step.type === "title" ? `Title of the new ${step.container.name} ticket` : undefined}
      empty={step.type === "title" ? "Type a title, then press Enter." : undefined}
      hints={prompting ? ["↑↓ move", "↵ select", "esc back"] : undefined}
      onQuery={(q) => (setQuery(q), setActive(0))}
      onActive={setActive}
      onRun={(c) => (c.stay ? c.run() : (close(false), c.run()))}
      onClose={() => (prompting ? go({ type: "search" }) : close(false))}
    />
  );
}
