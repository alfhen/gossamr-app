import { showOf } from "../lib/keys";
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import { containerKey, describeFilter, filterChips } from "../lib/filter";
import type { WorkContainer } from "../types";
import { useWorkspace } from "../workspaceStore";
import { BUILT_IN_VIEWS, projectOf, sameProject } from "./filters";
import { useActiveTab, useFilterCounts, useLookup } from "./hooks";
import { workConnections, workContainers } from "./domains";
import { usePopover } from "./Popover";
import { projectColour, projectInitials } from "./projects";
import { usePrefs } from "./prefs";
import { Icon } from "./AgentIcons";
import { Icon as Glyph } from "../components/icons";
import { PipGlyph } from "../components/PipGlyph";
import { SavedViewsPanel } from "./SavedViews";
import { useTabs } from "./tabsStore";
import { RAIL_BADGES, matchesQuery, nounFor, railSplit, type Noun } from "./watchLogic";
import { togglePip } from "./workstreamsStore";
import { NeedsYouList } from "./NeedsYou";
import { needsYouText, useNeedsYou } from "./useNeeds";
import { SearchField } from "../components/SearchField";

/** Fixed so the scrolling project list can't clip it. */
export function RailTip({ label, hint, note, at }: { label: string; hint?: string; note?: string; at: { x: number; y: number } | null }) {
  if (!at) return null;
  return (
    <span
      role="tooltip"
      style={{ left: at.x, top: at.y }}
      // While the pointer is on any rail button, only the hovered button's tip shows, so a focused one gives way to it, and none shows while a rail popover is open, so glass never stacks.
      className="pointer-events-none fixed z-40 -translate-y-1/2 not-group-has-[button:hover]/btn:group-has-[button:hover]/rail:hidden group-has-[[role=dialog]]/rail:hidden ws-glass ws-glass-regular rounded-md px-2 py-1 text-sm font-semibold whitespace-nowrap text-ws-ink"
    >
      {label}
      {hint && <kbd className="ml-1.5">{hint}</kbd>}
      {note && <span className="block text-xs font-medium text-ws-ink">{note}</span>}
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
    <span className="group/btn relative">
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

const plain = (current: boolean) => (current ? "text-ws-ink" : "text-ws-ink2 ws-rail-hover");

/** A button whose popover is open holds the hover lens; the sliding lens marks only where you are. */
const held = (open: boolean) => (open ? "text-ws-ink ws-glass-lens" : plain(false));

/** Slides the rail's lens to the current button; it hides when that button is scrolled out of the project list. */
function useRailLens(rail: RefObject<HTMLElement | null>, lens: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const box = rail.current;
    const el = lens.current;
    if (!box || !el) return;
    const list = box.querySelector<HTMLElement>('[role="group"]');
    const place = () => {
      const on = box.querySelector<HTMLElement>('button[aria-current="page"]');
      if (!on) {
        el.style.opacity = "0";
        return;
      }
      const b = on.getBoundingClientRect();
      const at = box.getBoundingClientRect();
      const clip = on.closest('[role="group"]')?.getBoundingClientRect();
      const hidden = clip !== undefined && (b.bottom > clip.bottom + 1 || b.top < clip.top - 1);
      el.style.width = `${b.width}px`;
      el.style.height = `${b.height}px`;
      el.style.transform = `translate(${b.left - at.left}px, ${b.top - at.top}px)`;
      el.style.opacity = hidden ? "0" : "1";
    };
    place();
    const frame = requestAnimationFrame(() => (el.dataset.ready = ""));
    const watch = new ResizeObserver(place);
    watch.observe(box);
    list?.addEventListener("scroll", place);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      list?.removeEventListener("scroll", place);
    };
  });
}

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
      <RailButton label="Views" tip={!open} aria-expanded={open} data-popover-trigger onClick={() => setOpen(!open)} className={`text-lg ${held(open)}`}>
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
      <SearchField className="m-2.5" aria-label={`Search watched ${noun.many}`} placeholder={`Find a ${noun.one}`} value={query} onChange={onQuery} />
      <ul role="menu" aria-label={`Watched ${noun.many}`} className="m-0 max-h-[min(320px,50vh)] list-none overflow-y-auto p-0 pb-1">
        {shown.map((c) => (
          <li key={containerKey(c.ref)} role="none">
            <button type="button" role="menuitem" onClick={() => onPick(c)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium ws-glass-item">
              <span aria-hidden style={{ background: colourOf(c) }} className="grid size-6 shrink-0 place-items-center rounded-[7px] text-[10px] font-bold text-white">
                {projectInitials(c)}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="shrink-0 text-xs font-medium text-ws-ink">{c.key}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li role="presentation" className="px-3 py-2 font-medium text-ws-ink">
            {query.trim() ? `No watched ${noun.one} matches.` : `Every ${noun.one} you watch is pinned.`}
          </li>
        )}
      </ul>
      <button type="button" onClick={onManage} className="border-t border-ws-sep px-3 py-2 text-left font-semibold text-ws-ink ws-glass-item">
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
      <RailButton label={`More ${noun.many}`} tip={!open} aria-expanded={open} data-popover-trigger onClick={() => (setQuery(""), setOpen(!open))} className={`text-lg ${held(open)}`}>
        <span aria-hidden>⋯</span>
      </RailButton>
      {open && (
        <div role="dialog" aria-label={`Watched ${noun.many}`} className="absolute bottom-0 left-full z-40 ml-2 w-[280px] overflow-hidden ws-glass ws-glass-regular rounded-xl text-ws-ink">
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

/** A count over a rail button, named and titled with what it counts: the one count of what needs you, the only badge. */
function RailBadge({ count, what }: { count: number; what: string }) {
  return (
    <span aria-label={what} title={what} className="absolute -top-[3px] -right-[3px] grid h-[16px] min-w-[16px] place-items-center rounded-full bg-ws-accent px-1 text-[10px] font-semibold text-white shadow-[var(--bead-top),var(--bead-bottom)]">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** What the rail badge counts, as its tooltip says and as the button's name ends ("Work, 3 things need you"). Inbox has none: what needs you is counted once, on Work. */
export const railBadgeText = {
  agents: needsYouText,
};

/** How the rail's Agents button opens what needs the person without leaving the screen. */
export const AGENTS_TRAY_NOTE = "Right-click or Shift+F10: what needs you";

/**
 * Agents, with how many things need the person across the workstreams: the one count (`needs.length`). Its context menu
 * (a right click, or the keyboard's menu key) opens the Needs you list as a popover from any route; a need there opens on Agents.
 */
function AgentsButton({ current }: { current: boolean }) {
  const items = useNeedsYou();
  const { open, setOpen, root } = usePopover();
  const count = items.length;
  return (
    <div ref={root} className="relative">
      <RailButton
        label={count > 0 ? `Work, ${railBadgeText.agents(count)}` : "Work"}
        tip={!open}
        current={current}
        // A click goes to Agents; what needs the person opens beside it from the context menu (right-click or Shift+F10).
        note={AGENTS_TRAY_NOTE}
        aria-description={AGENTS_TRAY_NOTE}
        data-popover-trigger
        onClick={() => (setOpen(false), useTabs.getState().setRoute("agents"))}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setOpen(!open);
        }}
        className={`text-lg ${plain(current)}`}
      >
        <Icon name="term" className="size-[19px]" />
        {count > 0 && <RailBadge count={count} what={railBadgeText.agents(count)} />}
      </RailButton>
      {open && (
        <div role="dialog" aria-label="Needs you" className="absolute bottom-0 left-full z-40 ml-2 w-[300px] overflow-hidden rounded-xl border border-ws-sep2 bg-ws-win text-ws-ink shadow-ws-pop">
          <NeedsYouList needs={items} compact onPick={() => setOpen(false)} />
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
  const pipOpen = usePrefs((s) => s.pipOpen);
  const setPaletteOpen = usePrefs((s) => s.setPaletteOpen);
  const project = projectOf(tab.filter);
  const inWorkspace = route === "workspace";
  const all = workContainers(Object.values(containers)).sort((a, b) => a.key.localeCompare(b.key));
  const { badges, rest } = railSplit(all, watch, project, RAIL_BADGES);
  const colourOf = (c: WorkContainer) => projectColour(all, c.ref);
  const noun = nounFor(kind);
  const glass = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLSpanElement>(null);
  useRailLens(glass, lens);

  return (
    <aside data-rail aria-label="Workspace sidebar" className="group/rail relative flex min-h-0 flex-col px-1.5 pt-10 pb-2">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
      <div ref={glass} className="ws-rail flex min-h-0 flex-1 flex-col items-center gap-2 p-[5px]">
      <span ref={lens} aria-hidden className="ws-rail-lens opacity-0" />
      <nav aria-label="Workspace" className="flex min-h-0 w-full flex-1 flex-col items-center gap-2">
        <RailButton label="Search and jump" hint={showOf("app", "jump")} onClick={() => setPaletteOpen(true)} className={`text-lg ${plain(false)}`}>
          <Glyph name="search" className="size-[17px]" />
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
            >
              <span aria-hidden className="ws-proj-bead" style={{ ["--pc" as string]: colour }}>
                {projectInitials(c)}
              </span>
            </RailButton>
          );
        })}
        </div>
        <ProjectsMenuButton rest={rest} colourOf={colourOf} noun={noun} />
        <Divider />
        <ViewsButton />
      </nav>
      <div className="flex w-full shrink-0 flex-col items-center gap-2 border-t border-ws-sep pt-2">
        <RailButton label="Inbox" current={route === "activity"} onClick={() => setRoute("activity")} className={`text-lg ${plain(route === "activity")}`}>
          <BellIcon />
        </RailButton>
        <AgentsButton current={route === "agents"} />
        <RailButton label="Settings" current={route === "settings"} onClick={() => setRoute("settings")} className={`text-lg ${plain(route === "settings")}`}>
          <span aria-hidden>⚙</span>
        </RailButton>
        <RailButton label="Pip" hint={showOf("app", "pip")} pressed={pipOpen} onClick={togglePip} className={`text-lg ${pipOpen ? "text-ws-pip ws-glass-lens" : plain(false)}`}>
          <PipGlyph />
        </RailButton>
      </div>
      </div>
    </aside>
  );
}
