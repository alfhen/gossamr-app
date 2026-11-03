import { useState, type KeyboardEvent } from "react";
import { accountOf, ALL, and, containerKey, describeFilter, withAccount } from "../lib/filter";
import { CODE_FILTERS, CODE_FILTER_LABEL } from "../lib/devLinks";
import { showsCode } from "./connectionsLogic";
import { jiraOn } from "./domains";
import type { CodeFilterKind, ContainerRef, WorkContainer, WorkFilter } from "../types";
import { useWorkspace } from "../workspaceStore";
import { usePopover } from "./Popover";
import { filterChips } from "../lib/filter";
import { projectOf, sameProject, refine, scopeTo, showsEntry, visibleChips, withoutChip, withProject } from "./filters";
import { useActiveTab, useLookup } from "./hooks";
import { SaveViewInline } from "./SavedViews";
import { buildTabItems } from "./tabItems";
import { useTabs } from "./tabsStore";
import { Button } from "../components/Button";

export function ChipRow({ chips, onRemove }: { chips: { label: string }[]; onRemove(index: number): void }) {
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0" aria-label="Active filters">
      {chips.map((c, i) => (
        <li key={i} className="inline-flex items-center gap-1 rounded-xl bg-ws-accent-soft py-px pr-1 pl-2.5 text-sm font-semibold text-ws-accent">
          {c.label}
          <button
            type="button"
            aria-label={`Remove filter ${c.label}`}
            onClick={() => onRemove(i)}
            className="rounded-full px-1.5 text-lg leading-none opacity-70 hover:opacity-100"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ProjectSwitcher({
  containers,
  value,
  onChange,
}: {
  containers: WorkContainer[];
  value: ContainerRef | null;
  onChange(project: ContainerRef | null): void;
}) {
  return (
    <select
      aria-label="Project"
      value={value ? containerKey(value) : ""}
      onChange={(ev) => onChange(containers.find((c) => containerKey(c.ref) === ev.target.value)?.ref ?? null)}
      className="rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink"
    >
      <option value="">All projects</option>
      {containers.map((c) => (
        <option key={containerKey(c.ref)} value={containerKey(c.ref)}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** Narrows to one Jira account's tickets. Only offered while several are on. */
export function AccountFilter({ accounts, value, onChange }: { accounts: readonly { id: string; displayName: string }[]; value: string | null; onChange(connectionId: string | null): void }) {
  return (
    <select
      aria-label="Account"
      value={value ?? ""}
      onChange={(ev) => onChange(ev.target.value || null)}
      className={`shrink-0 rounded-md bg-transparent px-1.5 py-1 text-sm font-semibold hover:bg-ws-hover ${value ? "text-ws-accent" : "text-ws-ink2"}`}
    >
      <option value="">All accounts</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.displayName}
        </option>
      ))}
    </select>
  );
}

/** Narrows to tickets by their linked pull requests. Only offered while a code host is connected. */
export function CodeFilterMenu({ active, onToggle }: { active: ReadonlySet<CodeFilterKind>; onToggle(check: CodeFilterKind): void }) {
  const { open, setOpen, root } = usePopover();
  return (
    <div ref={root} className="relative shrink-0">
      <Button variant="plain" size="sm" data-popover-trigger aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className={active.size ? "font-semibold text-ws-accent" : "font-semibold"}>
        Pull requests <span aria-hidden className="text-xs font-normal opacity-70">▾</span>
      </Button>
      {open && (
        <ul role="menu" aria-label="Filter by pull requests" className="absolute top-full right-0 z-30 m-0 mt-1 grid min-w-44 list-none gap-px ws-glass ws-glass-regular rounded-lg p-1 text-sm font-medium text-ws-ink">
          {CODE_FILTERS.map((k) => (
            <li key={k} role="none">
              <button type="button" role="menuitemcheckbox" aria-checked={active.has(k)} onClick={() => onToggle(k)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ws-glass-item">
                <span aria-hidden className="w-3 text-ws-accent">
                  {active.has(k) ? "✓" : ""}
                </span>
                {CODE_FILTER_LABEL[k]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FilterBar() {
  const tab = useActiveTab();
  const lookup = useLookup();
  const tabs = useTabs((s) => s.tabs);
  const savedViews = useTabs((s) => s.savedViews);
  const { setFilter, saveView } = useTabs.getState();
  const [text, setText] = useState("");
  const hasGithub = useWorkspace((s) => showsCode(s.connections));
  const connections = useWorkspace((s) => s.connections);
  const accounts = jiraOn(connections);
  const activeCode = new Set(filterChips(tab.filter).flatMap((c) => (c.type === "code" ? [c.check] : [])));
  const toggleCode = (check: CodeFilterKind) => {
    const chip: WorkFilter = { type: "code", check };
    const at = filterChips(tab.filter).findIndex((c) => c.type === "code" && c.check === check);
    if (at >= 0) setFilter(withoutChip(tab.filter, at));
    else setFilter(and(...filterChips(tab.filter), chip));
  };

  const stand = buildTabItems(tabs, tab.id, savedViews, () => "").find((i) => i.active && i.kind !== "custom");
  const chips = visibleChips(tab.filter, stand?.filter ?? null);
  const project = projectOf(tab.filter);
  const saved = savedViews.find((v) => showsEntry(v.filter, tab.filter) && sameProject(projectOf(v.filter), project));

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" && text.trim()) {
      setFilter(refine(tab.filter, text, lookup));
      setText("");
    } else if (ev.key === "Backspace" && !text && chips.length) {
      setFilter(withoutChip(tab.filter, chips[chips.length - 1].index));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-6 pt-2.5 pb-1">
      <ChipRow chips={chips.map((c) => ({ label: describeFilter(c.chip, lookup) }))} onRemove={(i) => setFilter(withoutChip(tab.filter, chips[i].index))} />
      <input
        type="text"
        aria-label="Filter"
        placeholder="Filter: type words, then Enter"
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-[200px] flex-1 rounded-md bg-transparent px-2 py-1 outline-none placeholder:text-ws-ink3 focus-visible:bg-ws-hover"
      />
      {accounts.length > 1 && <AccountFilter accounts={accounts} value={accountOf(tab.filter)} onChange={(id) => setFilter(withAccount(tab.filter, id))} />}
      {hasGithub && <CodeFilterMenu active={activeCode} onToggle={toggleCode} />}
      {chips.length > 0 && (
        <Button variant="quiet" size="sm" className="shrink-0" onClick={() => setFilter(scopeTo(stand?.filter ?? ALL, project))}>
          Reset
        </Button>
      )}
      {filterChips(tab.filter).some((c) => c.type !== "container") &&
        (saved ? (
          <span className="shrink-0 text-sm text-ws-ink3">Saved as {saved.name}</span>
        ) : (
          <SaveViewInline suggested={describeFilter(withProject(tab.filter, null), lookup)} onSave={saveView} />
        ))}
    </div>
  );
}
