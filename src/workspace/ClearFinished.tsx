import { useEffect, useMemo, useState } from "react";
import { CLEAR_AGES, CLEAR_STATES, DEFAULT_CLEAR, clearSentence, keptText } from "../lib/archiveRuns";
import type { ClearFilter, ClearPreview, Run, RunState } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Icon } from "./AgentIcons";
import { Btn } from "./AgentSheet";
import { usePopover } from "./Popover";
import { useRuns } from "./runsStore";
import { useNeedsYou } from "./useNeeds";

export interface ClearFinishedViewProps {
  open: boolean;
  onToggle(): void;
  filter: Pick<ClearFilter, "olderThanDays" | "states">;
  /** Null until the first preview arrives. */
  preview: ClearPreview | null;
  busy: boolean;
  onAge(days: number | null): void;
  onState(state: RunState, on: boolean): void;
  onConfirm(): void;
}

const ageText = (days: number | null) => (days === null ? "Any age" : days === 1 ? "Older than 1 day" : `Older than ${days} days`);

export function ClearFinishedView({ open, onToggle, filter, preview, busy, onAge, onState, onConfirm }: ClearFinishedViewProps) {
  const n = preview?.ids.length ?? 0;
  const kept = preview ? keptText(preview.kept) : null;
  return (
    <>
      <button
        type="button"
        data-popover-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
        title="Archive finished runs in one go"
        className="inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover"
      >
        <Icon name="folder" />
        Clear finished…
      </button>
      {open && (
        <div role="dialog" aria-label="Clear finished runs" className="absolute top-full right-0 z-30 mt-1 grid w-[340px] max-w-[90vw] gap-3 rounded-lg border border-ws-sep2 bg-ws-win p-3 text-sm shadow-lg">
          <label className="grid gap-1">
            <span className="text-xs font-semibold tracking-[0.05em] text-ws-ink3 uppercase">Which runs</span>
            <select aria-label="Age" value={String(filter.olderThanDays)} onChange={(ev) => onAge(ev.target.value === "null" ? null : Number(ev.target.value))} className="ws-select">
              {CLEAR_AGES.map((d) => (
                <option key={String(d)} value={String(d)}>
                  {ageText(d)}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="m-0 flex flex-wrap gap-x-3 gap-y-1 border-0 p-0">
            <legend className="sr-only">States</legend>
            {CLEAR_STATES.map(({ state, label }) => (
              <label key={state} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={filter.states.includes(state)} onChange={(ev) => onState(state, ev.target.checked)} />
                {label}
              </label>
            ))}
          </fieldset>
          <p aria-live="polite" data-clear-preview className="m-0 font-semibold text-ws-ink">
            {preview ? clearSentence(preview, filter) : "Counting…"}
          </p>
          {kept && <p className="m-0 text-ws-ink2">{kept}</p>}
          <p className="m-0 text-xs text-ws-ink3">Running runs, runs waiting on an answer, and runs with a draft to approve are never included. Archived runs can be restored.</p>
          <div className="flex items-center gap-2">
            <Btn tone="primary" disabled={n === 0 || busy} onClick={onConfirm}>
              {busy ? "Archiving…" : n === 0 ? "Archive" : `Archive ${n} ${n === 1 ? "run" : "runs"}`}
            </Btn>
            <Btn tone="ghost" onClick={onToggle}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
    </>
  );
}

/** The header's "Clear finished…": a popover whose preview is the backend's own count for the choices made. */
export function ClearFinished({ runs }: { runs: readonly Run[] }) {
  const { open, setOpen, root } = usePopover();
  const [filter, setFilter] = useState(DEFAULT_CLEAR);
  const [preview, setPreview] = useState<ClearPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const needs = useNeedsYou();
  const keep = useMemo(() => needs.flatMap((n) => (n.runId ? [n.runId] : [])), [needs]);
  const proposals = useWorkspace((s) => s.proposals);
  const backend = useRuns((s) => s.backend);
  const query = useMemo<ClearFilter>(() => ({ ...filter, keep }), [filter, keep]);

  useEffect(() => {
    if (!open || !backend) return;
    let current = true;
    backend.runsClearPreview(query).then((p) => current && setPreview(p), () => current && setPreview(null));
    return () => {
      current = false;
    };
  }, [open, backend, query, runs, proposals]);

  return (
    <div ref={root} className="relative">
      <ClearFinishedView
        open={open}
        onToggle={() => setOpen(!open)}
        filter={filter}
        preview={preview}
        busy={busy}
        onAge={(olderThanDays) => setFilter((f) => ({ ...f, olderThanDays }))}
        onState={(state, on) => setFilter((f) => ({ ...f, states: on ? [...f.states, state] : f.states.filter((s) => s !== state) }))}
        onConfirm={async () => {
          setBusy(true);
          await useRuns.getState().clearFinished(query);
          setBusy(false);
          setOpen(false);
        }}
      />
    </div>
  );
}
