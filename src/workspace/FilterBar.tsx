import { useState, type KeyboardEvent } from "react";
import { ALL, containerKey, describeFilter } from "../lib/filter";
import type { ContainerRef, WorkContainer } from "../types";
import { filterChips } from "../lib/filter";
import { projectOf, sameProject, refine, scopeTo, showsEntry, visibleChips, withoutChip, withProject } from "./filters";
import { useActiveTab, useLookup } from "./hooks";
import { SaveViewInline } from "./SavedViews";
import { buildTabItems } from "./tabItems";
import { useTabs } from "./tabsStore";

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

export function FilterBar() {
  const tab = useActiveTab();
  const lookup = useLookup();
  const tabs = useTabs((s) => s.tabs);
  const savedViews = useTabs((s) => s.savedViews);
  const { setFilter, saveView } = useTabs.getState();
  const [text, setText] = useState("");

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
      {chips.length > 0 && (
        <button type="button" className="shrink-0 text-sm text-ws-ink3 underline hover:text-ws-ink" onClick={() => setFilter(scopeTo(stand?.filter ?? ALL, project))}>
          Reset
        </button>
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
