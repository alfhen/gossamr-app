import { useState, type KeyboardEvent } from "react";
import { containerKey, describeFilter, filterChips } from "../lib/filter";
import type { ContainerRef, WorkContainer, WorkFilter } from "../types";
import { allContainers, useItemsByFilter, useWorkspace } from "../workspaceStore";
import { projectOf, refine, withoutChip } from "./filters";
import { useActiveTab, useLookup } from "./hooks";
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
  const containers = useWorkspace((s) => s.containers);
  const setFilter = useTabs((s) => s.setFilter);
  const setProject = useTabs((s) => s.setProject);
  const saveView = useTabs((s) => s.saveView);
  const count = useItemsByFilter(tab.filter).length;
  const [text, setText] = useState("");

  const chips: WorkFilter[] = filterChips(tab.filter);

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" && text.trim()) {
      setFilter(refine(tab.filter, text, lookup));
      setText("");
    } else if (ev.key === "Backspace" && !text && chips.length) {
      setFilter(withoutChip(tab.filter, chips.length - 1));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-ws-sep px-6 py-2">
      <ProjectSwitcher containers={allContainers({ containers })} value={projectOf(tab.filter)} onChange={setProject} />
      <ChipRow chips={chips.map((c) => ({ label: describeFilter(c, lookup) }))} onRemove={(i) => setFilter(withoutChip(tab.filter, i))} />
      <input
        type="text"
        aria-label="Filter"
        placeholder="Filter: type words, then Enter"
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-[200px] flex-1 rounded-md bg-transparent px-2 py-1 outline-none placeholder:text-ws-ink3 focus-visible:bg-ws-hover"
      />
      <span className="text-sm text-ws-ink3" aria-live="polite">
        {count} {count === 1 ? "item" : "items"}
      </span>
      {chips.length > 0 && (
        <button type="button" className="text-sm text-ws-ink3 underline" onClick={() => saveView(describeFilter(tab.filter, lookup))}>
          Save view
        </button>
      )}
    </div>
  );
}
