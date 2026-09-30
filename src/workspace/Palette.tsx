import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ALL, containerKey, itemKey } from "../lib/filter";
import type { CatalogEntry, ContainerRef, WorkContainer, WorkItem } from "../types";
import { itemsByFilter, pendingDrafts, useWorkspace } from "../workspaceStore";
import { askPip } from "./askPip";
import { useToasts } from "./toasts";
import { useActivity } from "./activityStore";
import { buildCommands, keyCommand, newTicketIntent, projectChoices, pullCommand, rankCommands, ticketCommands, unwatchCommands, watchCommands, withAskPip, type Command, type CommandActions, type CommandContext } from "./commands";
import { workContainers } from "./domains";
import { projectOf, withProject } from "./filters";
import { usePrefs } from "./prefs";
import { activeTab, allSavedViews, useTabs } from "./tabsStore";
import { openTicketByKey } from "./jump";
import { useGithubUi } from "./githubUi";
import { openPull } from "./openPull";

/** Where focus lands when the palette closes and the element that opened it is gone. */
export const MAIN_ID = "workspace-main";

const KBD = "rounded border border-ws-sep2 bg-ws-win px-1 font-sans text-[11px]";

export function PaletteView({
  query,
  results,
  active,
  placeholder = "Switch project, change view, jump to a ticket, or ask Pip…",
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown} className="ws-pop w-[min(560px,92vw)] overflow-hidden rounded-[14px] border border-ws-sep2 bg-ws-win shadow-ws-pop">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
          aria-label="Search commands and tickets"
          placeholder={placeholder}
          value={query}
          onChange={(ev) => onQuery(ev.target.value)}
          className="w-full border-b border-ws-sep bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-ws-ink3"
        />
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
        <div className="flex gap-3.5 border-t border-ws-sep bg-ws-bar px-3.5 py-2 text-xs text-ws-ink3">
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
    openTicket: (key) => void openTicketByKey(key),
    openActivity: () => tabs.setRoute("activity"),
    openDrafts: () => (useActivity.getState().setChip("drafts"), tabs.setRoute("activity")),
    connectGithub: () => useGithubUi.getState().openConnect(),
    manageRepositories: () => tabs.openSettings("watching"),
    openPull: (ref) => void openPull(ref),
    newTab: () => void tabs.openTab(),
    newTicket: () => {},
    togglePip: () => prefs.setPipOpen(!usePrefs.getState().pipOpen),
    jumpToItem,
    askPip,
  };
}

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
  const savedViews = useTabs((s) => s.savedViews);
  const tab = useTabs((s) => activeTab(s));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [step, setStep] = useState<Step>({ type: "search" });
  const unwatched = useUnwatchedMatches(query, step.type === "search");

  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => () => (opener?.isConnected ? opener : document.getElementById(MAIN_ID))?.focus(), [opener]);

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
    const ctx: CommandContext = { project: projectOf(tab.filter) ?? null, view: tab.view, unreadActivity: unread, pendingDrafts: pendingDrafts({ proposals }).length, github };
    const commands = buildCommands(sorted, allSavedViews({ savedViews }), actions, ctx);
    const all = Object.values(items);
    const found = [
      ...ticketCommands(all, query, actions.jumpToItem),
      ...keyCommand(query, all, actions.openTicket),
      ...pullCommand(query, actions.openPull),
      ...rankCommands([...commands, ...unwatchCommands(sorted.filter((c) => watch.find((w) => w.connectionId === c.ref.connectionId)?.mode === "selected"), query, actions)], query),
      ...watchCommands(unwatched.map((e) => ({ ref: e.ref, key: e.key, name: e.name })), actions),
    ];
    return withAskPip(found, query, actions.askPip);
  }, [containers, items, watch, proposals, github, unread, savedViews, tab.filter, tab.view, query, step, unwatched]);

  const prompting = step.type !== "search";
  return (
    <PaletteView
      query={query}
      results={results}
      active={Math.min(active, Math.max(0, results.length - 1))}
      placeholder={step.type === "project" ? "Which project is the ticket for?" : step.type === "title" ? `Title of the new ${step.container.name} ticket` : undefined}
      empty={step.type === "title" ? "Type a title, then press Enter. Pip drafts it; you approve it." : undefined}
      hints={prompting ? ["↑↓ move", "↵ select", "esc back"] : undefined}
      onQuery={(q) => (setQuery(q), setActive(0))}
      onActive={setActive}
      onRun={(c) => (c.stay ? c.run() : (close(false), c.run()))}
      onClose={() => (prompting ? go({ type: "search" }) : close(false))}
    />
  );
}
