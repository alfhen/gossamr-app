import type { CSSProperties, ReactNode } from "react";
import { containerKey, describeFilter, filterChips } from "../lib/filter";
import { allContainers, useWorkspace } from "../workspaceStore";
import { BUILT_IN_VIEWS, projectOf, sameProject } from "./filters";
import { useActivity } from "./activityStore";
import { useActiveTab, useFilterCounts, useLookup } from "./hooks";
import { usePopover } from "./Popover";
import { projectColour, projectInitials } from "./projects";
import { usePrefs } from "./prefs";
import { SavedViewsPanel } from "./SavedViews";
import { useTabs } from "./tabsStore";

export function RailTip({ label, hint }: { label: string; hint?: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute top-1/2 left-full z-40 ml-2 -translate-y-1/2 rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-sm font-semibold whitespace-nowrap text-ws-ink opacity-0 shadow-ws-pop transition-opacity group-hover/tip:opacity-100 group-has-[:focus-visible]/tip:opacity-100"
    >
      {label}
      {hint && <kbd className="ml-1.5">{hint}</kbd>}
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
  ...rest
}: {
  label: string;
  hint?: string;
  current?: boolean;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  tip?: boolean;
  "data-popover-trigger"?: boolean;
  "aria-expanded"?: boolean;
}) {
  return (
    <span className="group/tip relative">
      <button
        type="button"
        aria-label={label}
        aria-current={current ? "page" : undefined}
        aria-pressed={pressed}
        onClick={onClick}
        style={style}
        className={`relative grid size-9 place-items-center rounded-[10px] font-bold transition-colors ${className}`}
        {...rest}
      >
        {children}
      </button>
      {tip && <RailTip label={label} hint={hint} />}
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

export function Rail() {
  const tab = useActiveTab();
  const route = useTabs((s) => s.route);
  const { setRoute, setProject } = useTabs.getState();
  const containers = useWorkspace((s) => s.containers);
  const unread = useActivity((s) => s.unread);
  const pipOpen = usePrefs((s) => s.pipOpen);
  const setPipOpen = usePrefs((s) => s.setPipOpen);
  const setPaletteOpen = usePrefs((s) => s.setPaletteOpen);
  const project = projectOf(tab.filter);
  const inWorkspace = route === "workspace";
  const list = allContainers({ containers });

  return (
    <aside className="relative flex min-h-0 flex-col items-center gap-2 border-r border-ws-sep bg-ws-side pt-10 pb-2.5">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
      <nav aria-label="Workspace" className="flex flex-col items-center gap-2">
        <RailButton label="Search and jump" hint="⌘K" onClick={() => setPaletteOpen(true)} className={`text-lg ${plain(false)}`}>
          <span aria-hidden>⌕</span>
        </RailButton>
        <Divider />
        <RailButton label="All projects" current={inWorkspace && !project} onClick={() => setProject(null)} className={`text-lg ${plain(inWorkspace && !project)}`}>
          <span aria-hidden>∗</span>
        </RailButton>
        {list.map((c) => {
          const on = inWorkspace && sameProject(project, c.ref);
          const colour = projectColour(list, c.ref);
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
        <Divider />
        <ViewsButton />
      </nav>
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-2 border-t border-ws-sep pt-2.5">
        <RailButton label="Activity" current={route === "activity"} onClick={() => setRoute("activity")} className={`text-lg ${plain(route === "activity")}`}>
          <span aria-hidden>⚡</span>
          {unread > 0 && (
            <span aria-label={`${unread} unread`} className="absolute -top-[3px] -right-[3px] grid h-[16px] min-w-[16px] place-items-center rounded-full bg-ws-pip px-1 text-[10px] font-semibold text-ws-on-pip">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </RailButton>
        <RailButton label="Settings" current={route === "settings"} onClick={() => setRoute("settings")} className={`text-lg ${plain(route === "settings")}`}>
          <span aria-hidden>⚙</span>
        </RailButton>
        <RailButton label="Pip" hint="⌘J" pressed={pipOpen} onClick={() => setPipOpen(!pipOpen)} className={`text-lg ${pipOpen ? "bg-ws-win text-ws-pip shadow-[0_1px_4px_rgb(0_0_0/0.2)]" : "text-ws-ink2 hover:bg-ws-hover"}`}>
          <span aria-hidden>✦</span>
        </RailButton>
      </div>
    </aside>
  );
}
