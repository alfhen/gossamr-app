import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ALL, containerKey, itemKey } from "../lib/filter";
import type { CatalogEntry, ContainerRef, WorkContainer, WorkItem } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import { currentNeeds, useNeedsYou } from "./useNeeds";
import { openNeed } from "./needsActions";
import { askPip } from "./askPip";
import { useToasts } from "./toasts";
import { useActivity } from "./activityStore";
import { SUGGESTED_TICKETS, START_WORKSTREAM, buildCommands, agentCommands, askToPlanCommands, startWorkstreamCommands, noStartableTicket, workstreamCommands, keyCommand, newTicketIntent, projectChoices, pullCommand, rankCommands, searchOrder, ticketCommands, unwatchCommands, watchCommands, withAskPip, type Command, type CommandActions, type CommandContext } from "./commands";
import { workContainers } from "./domains";
import { ticketKeyOf } from "./watchLogic";
import { projectOf, withProject } from "./filters";
import { useAgentsEnabled } from "./agentsFlag";
import { usePrefs } from "./prefs";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { activeTab, allSavedViews, useTabs } from "./tabsStore";
import { openTicketByKey, useKeyConnectionId } from "./jump";
import { focusPeekOf } from "./PeekSheet";
import { useGithubUi } from "./githubUi";
import { openPull } from "./openPull";
import { openOnAgents, togglePip, useWorkstreams } from "./workstreamsStore";
import { contextEntries, focusedSubject } from "./contextActions";
import { undoLog } from "./undo";
import { showAllRuns } from "./TimelineFilterBar";
import { showStartMyDay } from "./StartMyDay";
import { showPlanMyWeek } from "./planActions";
import { giveBackClarity } from "./clarityActions";
import { learnedList } from "../lib/clarityLearning";

/** Where focus lands when the palette closes and the element that opened it is gone. */
export const MAIN_ID = "workspace-main";

const KBD = "rounded border border-ws-sep2 bg-ws-win px-1 font-sans text-[11px]";

/** The palette's placeholder when it is a plain search, and the input's name then. */
export const DEFAULT_PLACEHOLDER = "Switch project, change view, jump to a ticket, or ask Pip…";
export const SEARCH_NAME = "Search commands and tickets";

/** The input's accessible name: the question a mode asks ("Which ticket should the agent work on?"), since the placeholder alone is not reliably read; plain search keeps its name (G9). */
export const inputName = (placeholder: string) => (placeholder === DEFAULT_PLACEHOLDER ? SEARCH_NAME : placeholder.replace(/…$/, ""));

/** The footer line of "Start a workstream": what picking a ticket there does and does not do. */
export const START_WORKSTREAM_NOTE = "Opens a workstream; starts no agent and posts nothing.";

/** Above the list in "Start a workstream" until something is typed: the list is only some of the tickets, and typing narrows it to others. */
export const START_WORKSTREAM_HINT = "Only some tickets are listed. Type a key or words to find others.";

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
  note,
  lead,
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
  /** A line under the list, above the key hints: what picking a result does. */
  note?: string;
  /** A line between the input and the list. */
  lead?: string;
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown} className="ws-pop w-[min(560px,92vw)] overflow-hidden rounded-[14px] border border-ws-sep2 bg-ws-win shadow-ws-pop">
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
          className="w-full border-b border-ws-sep bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-ws-ink3"
        />
        {lead && (
          <p data-palette-lead className="m-0 border-b border-ws-sep px-3.5 py-1.5 text-xs text-ws-ink3">
            {lead}
          </p>
        )}
        <ul id="palette-list" role="listbox" aria-label="Results" className="m-0 max-h-[min(380px,50vh)] list-none overflow-auto p-1.5">
          {results.map((c, i) => (
            <Fragment key={c.id}>
              {c.group !== results[i - 1]?.group && (
                <li role="presentation" className="px-2.5 pt-2 pb-0.5 text-[11px] font-bold tracking-wide text-ws-ink3 uppercase">
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
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] ${c.group === "Ask Pip" ? "text-ws-pip" : ""} ${i === active ? "bg-ws-accent-soft" : ""}`}
              >
                <span aria-hidden className={`w-4 shrink-0 text-center ${c.group === "Ask Pip" ? "" : "text-ws-ink3"}`}>
                  {c.icon ?? "·"}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <span className="shrink-0 text-xs text-ws-ink3">{c.hint}</span>}
              </li>
            </Fragment>
          ))}
          {!results.length && <li role="presentation" className="px-3 py-3 text-ws-ink3">{empty ?? `Nothing matches “${query}”.`}</li>}
        </ul>
        {note && (
          <p data-palette-note className="m-0 border-t border-ws-sep bg-ws-bar px-3.5 pt-2 text-xs text-ws-ink3">
            {note}
          </p>
        )}
        <div className={`flex gap-3.5 bg-ws-bar px-3.5 py-2 text-xs text-ws-ink3 ${note ? "" : "border-t border-ws-sep"}`}>
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
      const ws = useWorkspace.getState();
      ws.watchContainers(target.ref.connectionId, [{ containerId: target.ref.externalId, watched, source: "manual" }]).then(
        () => useToasts.getState().push(watched ? `Watching ${target.name}.` : `Stopped watching ${target.name}. It stays in Settings for 14 days in case you change your mind.`, "info"),
        (e) => ws.report(`Couldn't ${watched ? "watch" : "unwatch"} ${target.name}`, e),
      );
    },
    // A ticket opened from here takes the keyboard into its peek, not back to the board behind it.
    openTicket: (key) => void openTicketByKey(key).then((shown) => shown && focusPeekOf(key)),
    openActivity: () => tabs.setRoute("activity"),
    openDrafts: () => (useActivity.getState().setChip("drafts"), tabs.setRoute("activity")),
    connectGithub: () => useGithubUi.getState().openConnect(),
    manageRepositories: () => tabs.openSettings("watching"),
    openPull: (ref) => void openPull(ref),
    newTab: () => void tabs.openTab(),
    newTicket: () => {},
    chooseWorkstream: () => {},
    togglePip,
    startAgent: () => useRuns.getState().setPicking(true),
    startAgentOn: (item, kind) => void useRunSetup.getState().begin({ item: item.item, kind }),
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
    holdAllWorkstreams: () => void useWorkstreams.getState().holdAll(),
    jumpToItem: (item) => {
      jumpToItem(item);
      focusPeekOf(item.item.key);
    },
    askPip,
    openAgents: showAllRuns,
    openWorkstream: openOnAgents,
    askPipToPlan: (item) => void askPipToPlan(item),
    // Starting one moves nothing on screen the palette owns, so say it in the live region; a failure is already toasted by start().
    startWorkstreamOn: (item) =>
      void useWorkstreams
        .getState()
        .start(item.item)
        .then((view) => view && useToasts.getState().push(`Started a workstream on ${item.item.key}.`, "info")),
    startMyDay: showStartMyDay,
    planMyWeek: showPlanMyWeek,
    openJiraSent: () => tabs.setRoute("sent"),
    giveBackClarity: () => void giveBackClarity(),
  };
}

/**
 * The palette's "Ask Pip to plan KEY": opens or finds the workstream on the ticket (as the person's own Start a
 * workstream does), shows it on Agents and asks Pip to plan it. Pip only drafts the plan run; nothing starts.
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

/** What the palette asks: anything, a new ticket's project, then its title, or (opened by 'Start a workstream…') the ticket to start a workstream on. */
type Step = { type: "search" } | { type: "project" } | { type: "title"; container: WorkContainer } | { type: "workstream" };

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
    useToasts.getState().push(`Drafted a new ticket in ${container.name}. Nothing is created until you approve it.`, "info");
    appActions().openDrafts();
  } catch (e) {
    useToasts.getState().push(e instanceof Error ? e.message : String(e));
  }
}

/** Containers matching the query that the person doesn't watch, searched on the server. */
function useUnwatchedMatches(query: string, enabled: boolean): CatalogEntry[] {
  const backend = useWorkspace((s) => s.backend);
  const selectedModes = useWorkspace((s) => s.watch.filter((w) => w.mode === "selected").map((w) => w.connectionId).join(","));
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
  const unread = useActivity((s) => s.unread + s.codeUnread);
  const agents = useAgentsEnabled();
  const needingMe = useNeedsYou().length;
  const savedViews = useTabs((s) => s.savedViews);
  const selected = useTabs((s) => s.selected);
  const workstreams = useWorkstreams((s) => s.list);
  const tab = useTabs((s) => activeTab(s));
  // Opened to do one thing, the search starts with its words; opened by Agents' 'Start a workstream…', it asks for the
  // ticket alone, offering the person's own first.
  const [seed] = useState(() => usePrefs.getState().paletteSeed);
  const [query, setQuery] = useState(() => (seed === START_WORKSTREAM ? "" : seed));
  const [active, setActive] = useState(0);
  const [step, setStep] = useState<Step>(() => (seed === START_WORKSTREAM ? { type: "workstream" } : { type: "search" }));
  const me = useWorkspace((s) => s.me);
  const clarityLearning = usePrefs((s) => s.clarityLearning);
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
    const actions = { ...appActions(), newTicket: () => go({ type: "project" }), chooseWorkstream: () => go({ type: "workstream" }) };
    if (step.type === "workstream") return startWorkstreamCommands(Object.values(items), START_WORKSTREAM + query, workstreams, actions, SUGGESTED_TICKETS, me);
    const ticket = peekedTicket();
    const ctx: CommandContext = {
      project: projectOf(tab.filter) ?? null,
      view: tab.view,
      unreadActivity: unread,
      github,
      agents,
      needsYou: needingMe,
      ticket: ticket ? { key: ticket.item.key, workstream: !!useWorkstreams.getState().forItem(ticket.item.key, ticket.item.connectionId) } : null,
      onAgents: useTabs.getState().route === "agents",
      clarityLearned: learnedList(clarityLearning).length,
    };
    const commands = buildCommands(sorted, allSavedViews({ savedViews }), actions, ctx);
    const all = Object.values(items);
    const tickets = ticketCommands(all, query, actions.jumpToItem);
    // A typed ticket key stays first; any other ticket comes after the commands the query names ("runs", "agents").
    const ranked = rankCommands([...contextEntries(subject, agents), ...undoEntries(), ...commands, ...unwatchCommands(sorted.filter((c) => watch.find((w) => w.connectionId === c.ref.connectionId)?.mode === "selected"), query, actions)], query);
    const order = searchOrder(tickets, ranked, query);
    const found = [
      ...order.head,
      ...order.tickets,
      ...keyCommand(query, all, actions.openTicket),
      ...pullCommand(query, actions.openPull),
      ...(agents ? askToPlanCommands(all, query, actions) : []),
      ...(agents ? agentCommands(all, query, actions.startAgentOn) : []),
      ...(agents ? workstreamCommands(workstreams, query, actions) : []),
      // The peeked ticket's own "Start a workstream" is in the commands already.
      ...(agents ? startWorkstreamCommands(all, query, workstreams, actions).filter((c) => !ticket || c.id !== `workstream:start:${itemKey(ticket.item)}`) : []),
      ...order.commands,
      ...watchCommands(unwatched.map((e) => ({ ref: e.ref, key: e.key, name: e.name })), actions),
    ];
    return withAskPip(found, query, actions.askPip);
  }, [containers, items, watch, proposals, github, unread, agents, needingMe, savedViews, tab.filter, tab.view, query, step, unwatched, selected, workstreams, me, subject, clarityLearning]);

  // A typed key that isn't among the watched tickets is looked up in the full cache (or read live), so a Done ticket there is said to be Done.
  const typedKey = step.type === "workstream" ? ticketKeyOf(query) : null;
  const unlisted = typedKey && !Object.values(items).some((i) => i.item.key.toUpperCase() === typedKey) ? typedKey : null;
  const [looked, setLooked] = useState<{ key: string; item: WorkItem | null } | null>(null);
  const connectionId = useKeyConnectionId();
  useEffect(() => {
    if (!unlisted || !connectionId) return;
    let current = true;
    const found = (item: WorkItem | null) => current && setLooked({ key: unlisted, item });
    useWorkspace.getState().peekItem({ connectionId, externalId: unlisted, key: unlisted }).then(found, () => found(null));
    return () => {
      current = false;
    };
  }, [unlisted, connectionId]);
  // A new ticket's project and title are steps back to the search; the workstream's ticket is all the palette was opened for.
  const prompting = step.type === "project" || step.type === "title";
  return (
    <PaletteView
      query={query}
      results={results}
      active={Math.min(active, Math.max(0, results.length - 1))}
      placeholder={step.type === "project" ? "Which project is the ticket for?" : step.type === "title" ? `Title of the new ${step.container.name} ticket` : step.type === "workstream" ? "Start a workstream: type a ticket key or words" : undefined}
      empty={step.type === "title" ? "Type a title, then press Enter. Pip drafts it; you approve it." : step.type === "workstream" ? noStartableTicket(Object.values(items), query, workstreams, looked?.key === ticketKeyOf(query) ? looked.item : null) : undefined}
      hints={prompting ? ["↑↓ move", "↵ select", "esc back"] : undefined}
      note={step.type === "workstream" ? START_WORKSTREAM_NOTE : undefined}
      lead={step.type === "workstream" && !query.trim() ? START_WORKSTREAM_HINT : undefined}
      onQuery={(q) => (setQuery(q), setActive(0))}
      onActive={setActive}
      onRun={(c) => (c.stay ? c.run() : (close(false), c.run()))}
      onClose={() => (prompting ? go({ type: "search" }) : close(false))}
    />
  );
}
