import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { containerKey, describeFilter, filterChips } from "../lib/filter";
import type { WorkContainer } from "../types";
import { useWorkspace } from "../workspaceStore";
import { BUILT_IN_VIEWS, projectOf, sameProject } from "./filters";
import { useActivity } from "./activityStore";
import { useActiveTab, useFilterCounts, useLookup } from "./hooks";
import { workConnections, workContainers } from "./domains";
import { usePopover } from "./Popover";
import { projectColour, projectInitials } from "./projects";
import { useAgentsEnabled } from "./agentsFlag";
import { usePrefs } from "./prefs";
import { useAttention } from "./runsStore";
import { Icon } from "./AgentIcons";
import { SavedViewsPanel } from "./SavedViews";
import { useTabs } from "./tabsStore";
import { RAIL_BADGES, matchesQuery, nounFor, railSplit, type Noun } from "./watchLogic";
import { useClaude } from "../claudeStore";
import { HOLD_ALL_HINT, PIP_HOME_HINT } from "./commands";
import { holdAllVisible, togglePip, useWorkstreams } from "./workstreamsStore";
import { NeedsYouTray, useNeedsYou } from "./NeedsYouTray";

/** Fixed so the scrolling project list can't clip it. */
export function RailTip({ label, hint, note, at }: { label: string; hint?: string; note?: string; at: { x: number; y: number } | null }) {
  if (!at) return null;
  return (
    <span
      role="tooltip"
      style={{ left: at.x, top: at.y }}
      className="pointer-events-none fixed z-40 -translate-y-1/2 rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-sm font-semibold whitespace-nowrap text-ws-ink shadow-ws-pop"
    >
      {label}
      {hint && <kbd className="ml-1.5">{hint}</kbd>}
      {note && <span className="block text-xs font-normal text-ws-ink3">{note}</span>}
    </span>
  );
}

export function RailButton({
  label,
  hint,
  current,
  pressed,
  onClick,
  children,
  className = "",
  style,
  tip = true,
  note,
  ...rest
}: {
  label: string;
  hint?: string;
  /** A second line in the tooltip, for what else the button does. */
  note?: string;
  current?: boolean;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  tip?: boolean;
  "data-popover-trigger"?: boolean;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog";
  "aria-description"?: string;
  onContextMenu?(ev: MouseEvent<HTMLButtonElement>): void;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ x: r.right + 8, y: r.top + r.height / 2 });
  };
  return (
    <span className="relative">
      <button
        type="button"
        aria-label={label}
        aria-current={current ? "page" : undefined}
        aria-pressed={pressed}
        onClick={onClick}
        onMouseEnter={(ev) => show(ev.currentTarget)}
        onMouseLeave={() => setAt(null)}
        onFocus={(ev) => ev.currentTarget.matches(":focus-visible") && show(ev.currentTarget)}
        onBlur={() => setAt(null)}
        style={style}
        className={`relative grid size-9 place-items-center rounded-[10px] font-bold transition-colors ${className}`}
        {...rest}
      >
        {children}
      </button>
      {tip && <RailTip label={label} hint={hint} note={note} at={at} />}
    </span>
  );
}

const plain = (current: boolean) => (current ? "bg-ws-win text-ws-ink shadow-[0_1px_4px_rgb(0_0_0/0.2)]" : "text-ws-ink2 hover:bg-ws-hover");

const Divider = () => <hr className="m-0 my-0.5 w-6 border-0 border-t border-ws-sep2" />;

function ViewsButton() {
  const { open, setOpen, root } = usePopover();
  const tab = useActiveTab();
  const lookup = useLookup();
  const savedViews = useTabs((s) => s.savedViews);
  const { openSavedView, saveView, renameSavedView, moveSavedView, pinSavedView, removeSavedView } = useTabs.getState();
  const counts = useFilterCounts(BUILT_IN_VIEWS.map((v) => v.filter));
  const hasFilter = filterChips(tab.filter).length > 0;

  return (
    <div ref={root} className="relative">
      <RailButton label="Views" tip={!open} aria-expanded={open} data-popover-trigger onClick={() => setOpen(!open)} className={`text-lg ${plain(open)}`}>
        <span aria-hidden>◎</span>
      </RailButton>
      {open && (
        <div role="dialog" aria-label="Views" className="absolute top-0 left-full z-40 ml-2 w-[280px] rounded-xl border border-ws-sep2 bg-ws-win text-ws-ink shadow-ws-pop">
          <SavedViewsPanel
            builtIn={BUILT_IN_VIEWS}
            saved={savedViews}
            counts={Object.fromEntries(BUILT_IN_VIEWS.map((v, i) => [v.id, counts[i]]))}
            suggested={hasFilter ? describeFilter(tab.filter, lookup) : null}
            onOpen={(v) => {
              openSavedView(v);
              setOpen(false);
            }}
            onSave={saveView}
            onRename={renameSavedView}
            onMove={moveSavedView}
            onPin={pinSavedView}
            onRemove={removeSavedView}
          />
        </div>
      )}
    </div>
  );
}

export interface ProjectsMenuPanelProps {
  rest: readonly WorkContainer[];
  colourOf(c: WorkContainer): string;
  noun: Noun;
  query: string;
  onQuery(q: string): void;
  onPick(c: WorkContainer): void;
  onManage(): void;
}

/** The watched containers that have no badge, with a way to find one and to change what is watched. */
export function ProjectsMenuPanel({ rest, colourOf, noun, query, onQuery, onPick, onManage }: ProjectsMenuPanelProps) {
  const shown = rest.filter((c) => matchesQuery(c, query));
  return (
    <div className="grid">
      <input
        type="search"
        aria-label={`Search watched ${noun.many}`}
        placeholder={`Find a ${noun.one}`}
        value={query}
        onChange={(ev) => onQuery(ev.target.value)}
        className="m-2.5 rounded-lg border border-ws-sep2 bg-ws-win px-2.5 py-1 outline-none placeholder:text-ws-ink3 focus:border-ws-accent"
      />
      <ul role="menu" aria-label={`Watched ${noun.many}`} className="m-0 max-h-[min(320px,50vh)] list-none overflow-y-auto p-0 pb-1">
        {shown.map((c) => (
          <li key={containerKey(c.ref)} role="none">
            <button type="button" role="menuitem" onClick={() => onPick(c)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-ws-hover">
              <span aria-hidden style={{ background: colourOf(c) }} className="grid size-6 shrink-0 place-items-center rounded-[7px] text-[10px] font-bold text-white">
                {projectInitials(c)}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="shrink-0 text-xs text-ws-ink3">{c.key}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li role="presentation" className="px-3 py-2 text-ws-ink3">
            {query.trim() ? `No watched ${noun.one} matches.` : `Every ${noun.one} you watch is pinned.`}
          </li>
        )}
      </ul>
      <button type="button" onClick={onManage} className="border-t border-ws-sep px-3 py-2 text-left font-semibold text-ws-accent hover:bg-ws-hover">
        Manage {noun.many}…
      </button>
    </div>
  );
}

function ProjectsMenuButton({ rest, colourOf, noun }: Pick<ProjectsMenuPanelProps, "rest" | "colourOf" | "noun">) {
  const { open, setOpen, root } = usePopover();
  const [query, setQuery] = useState("");
  return (
    <div ref={root} className="relative">
      <RailButton label={`More ${noun.many}`} tip={!open} aria-expanded={open} data-popover-trigger onClick={() => (setQuery(""), setOpen(!open))} className={`text-lg ${plain(open)}`}>
        <span aria-hidden>⋯</span>
      </RailButton>
      {open && (
        <div role="dialog" aria-label={`Watched ${noun.many}`} className="absolute bottom-0 left-full z-40 ml-2 w-[280px] overflow-hidden rounded-xl border border-ws-sep2 bg-ws-win text-ws-ink shadow-ws-pop">
          <ProjectsMenuPanel
            rest={rest}
            colourOf={colourOf}
            noun={noun}
            query={query}
            onQuery={setQuery}
            onPick={(c) => (setOpen(false), useTabs.getState().setProject(c.ref))}
            onManage={() => (setOpen(false), useTabs.getState().openSettings("watching"))}
          />
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-[19px] fill-none stroke-current" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

/**
 * Hold all, while anything could start on its own: a workstream in Manage that isn't held, or Pip answering in a
 * workstream's conversation. It holds every open workstream and stops Pip's turns in them; agents carry on.
 */
function HoldAllButton() {
  const managing = useWorkstreams((s) => holdAllVisible(s.list, {}));
  const answering = useClaude((s) => holdAllVisible([], s.byTicket));
  if (!managing && !answering) return null;
  return (
    <RailButton label="Hold all workstreams" hint={HOLD_ALL_HINT} onClick={() => void useWorkstreams.getState().holdAll()} className="text-lg text-ws-warn hover:bg-ws-hover">
      <span aria-hidden>⏸</span>
    </RailButton>
  );
}

/** "1 needs you" or "3 need you" over a rail button. */
function NeedsBadge({ count }: { count: number }) {
  return (
    <span aria-label={`${count} ${count === 1 ? "needs" : "need"} you`} className="absolute -top-[3px] -right-[3px] grid h-[16px] min-w-[16px] place-items-center rounded-full bg-ws-pip px-1 text-[10px] font-semibold text-ws-on-pip">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Pip home, with how many things wait on the person across the workstreams. Its context menu (a right click, or the
 * keyboard's menu key) opens the Needs you tray as a popover from any route; an item there goes to it on Pip home.
 */
/** How the rail's Pip home button opens what needs the person without leaving the screen. */
export const PIP_HOME_TRAY_NOTE = "Right-click or Shift+F10: what needs you";

function PipHomeButton({ current }: { current: boolean }) {
  const items = useNeedsYou();
  const { open, setOpen, root } = usePopover();
  const count = items.length;
  return (
    <div ref={root} className="relative">
      <RailButton
        label={count > 0 ? `Pip home, ${count} ${count === 1 ? "needs" : "need"} you` : "Pip home"}
        hint={PIP_HOME_HINT}
        tip={!open}
        current={current}
        // A click goes to Pip home; what needs the person opens beside it from the context menu (right-click or Shift+F10).
        note={PIP_HOME_TRAY_NOTE}
        aria-description={PIP_HOME_TRAY_NOTE}
        data-popover-trigger
        onClick={() => (setOpen(false), useTabs.getState().setRoute("pip"))}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setOpen(!open);
        }}
        className={`text-lg ${plain(current)}`}
      >
        <span aria-hidden>⌂</span>
        {count > 0 && <NeedsBadge count={count} />}
      </RailButton>
      {open && (
        <div role="dialog" aria-label="Needs you" className="absolute bottom-0 left-full z-40 ml-2 w-[300px] overflow-hidden rounded-xl border border-ws-sep2 bg-ws-win text-ws-ink shadow-ws-pop">
          <NeedsYouTray items={items} compact onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function Rail() {
  const tab = useActiveTab();
  const route = useTabs((s) => s.route);
  const { setRoute, setProject } = useTabs.getState();
  const containers = useWorkspace((s) => s.containers);
  const watch = useWorkspace((s) => s.watch);
  const kind = useWorkspace((s) => workConnections(s.connections)[0]?.kind);
  const unread = useActivity((s) => s.unread + s.codeUnread);
  const agentsEnabled = useAgentsEnabled();
  const attention = useAttention();
  // Pip home has its own composer in place of the pane, so there the Pip button goes to it.
  const pipOpen = usePrefs((s) => s.pipOpen) && route !== "pip";
  const setPaletteOpen = usePrefs((s) => s.setPaletteOpen);
  const project = projectOf(tab.filter);
  const inWorkspace = route === "workspace";
  const all = workContainers(Object.values(containers)).sort((a, b) => a.key.localeCompare(b.key));
  const { badges, rest } = railSplit(all, watch, project, RAIL_BADGES);
  const colourOf = (c: WorkContainer) => projectColour(all, c.ref);
  const noun = nounFor(kind);

  return (
    <aside className="relative flex min-h-0 flex-col items-center gap-2 border-r border-ws-sep bg-ws-side pt-10 pb-2.5">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
      <nav aria-label="Workspace" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2">
        <RailButton label="Search and jump" hint="⌘K" onClick={() => setPaletteOpen(true)} className={`text-lg ${plain(false)}`}>
          <span aria-hidden>⌕</span>
        </RailButton>
        <Divider />
        <RailButton label="All projects" current={inWorkspace && !project} onClick={() => setProject(null)} className={`text-lg ${plain(inWorkspace && !project)}`}>
          <span aria-hidden>∗</span>
        </RailButton>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-x-hidden overflow-y-auto py-1" aria-label="Projects" role="group">
        {badges.map((c) => {
          const on = inWorkspace && sameProject(project, c.ref);
          const colour = colourOf(c);
          return (
            <RailButton
              key={containerKey(c.ref)}
              label={c.name}
              current={on}
              onClick={() => setProject(c.ref)}
              style={{ background: colour, ["--pc" as string]: colour }}
              className={`text-xs text-white ${on ? "opacity-100 shadow-[0_0_0_2px_var(--color-ws-side),0_0_0_4px_var(--pc)]" : "opacity-70 hover:opacity-100"}`}
            >
              {projectInitials(c)}
            </RailButton>
          );
        })}
        </div>
        <ProjectsMenuButton rest={rest} colourOf={colourOf} noun={noun} />
        <Divider />
        <ViewsButton />
      </nav>
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-ws-sep pt-2.5">
        <RailButton label="Activity" current={route === "activity"} onClick={() => setRoute("activity")} className={`text-lg ${plain(route === "activity")}`}>
          <BellIcon />
          {unread > 0 && (
            <span aria-label={`${unread} unread`} className="absolute -top-[3px] -right-[3px] grid h-[16px] min-w-[16px] place-items-center rounded-full bg-ws-pip px-1 text-[10px] font-semibold text-ws-on-pip">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </RailButton>
        {agentsEnabled && (
          <RailButton label={attention > 0 ? `Agents, ${attention} ${attention === 1 ? "needs" : "need"} you` : "Agents"} current={route === "agents"} onClick={() => setRoute("agents")} className={`text-lg ${plain(route === "agents")}`}>
            <Icon name="term" className="size-[19px]" />
            {attention > 0 && (
              <span aria-label={`${attention} ${attention === 1 ? "needs" : "need"} you`} className="absolute -top-[3px] -right-[3px] grid h-[16px] min-w-[16px] place-items-center rounded-full bg-ws-pip px-1 text-[10px] font-semibold text-ws-on-pip">
                {attention > 99 ? "99+" : attention}
              </span>
            )}
          </RailButton>
        )}
        {agentsEnabled && <PipHomeButton current={route === "pip"} />}
        {agentsEnabled && <HoldAllButton />}
        <RailButton label="Settings" current={route === "settings"} onClick={() => setRoute("settings")} className={`text-lg ${plain(route === "settings")}`}>
          <span aria-hidden>⚙</span>
        </RailButton>
        <RailButton label="Pip" hint="⌘J" pressed={pipOpen} onClick={togglePip} className={`text-lg ${pipOpen ? "bg-ws-win text-ws-pip shadow-[0_1px_4px_rgb(0_0_0/0.2)]" : "text-ws-ink2 hover:bg-ws-hover"}`}>
          <span aria-hidden>✦</span>
        </RailButton>
      </div>
    </aside>
  );
}
