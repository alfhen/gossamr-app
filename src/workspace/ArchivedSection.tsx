import { useState } from "react";
import { sizeText } from "../lib/archiveRuns";
import type { Run, WorktreeInfo } from "../types";
import { Btn } from "./AgentSheet";
import { ageText, runTitle } from "./agentsLogic";
import { useRuns } from "./runsStore";
import { useWorkspace } from "../workspaceStore";
import { itemKey } from "../lib/filter";
import { Button } from "../components/Button";

/** What the person is asked while deleting one archived run. `info` is null until the folder has been looked at. */
export interface DeleteAsk {
  id: string;
  info: WorktreeInfo | null;
  removeWorktree: boolean;
  busy: boolean;
  /** Claude's own words when it would not remove the worktree. */
  refused: string | null;
}

export interface ArchivedSectionViewProps {
  runs: readonly Run[];
  open: boolean;
  now: number;
  ticketTitle(run: Run): string | null;
  asking: DeleteAsk | null;
  onToggle(): void;
  onRestore(id: string): void;
  onAskDelete(id: string): void;
  onCancelDelete(): void;
  onRemoveWorktree(on: boolean): void;
  onConfirmDelete(): void;
}

function DeletePanel({ ask, onRemoveWorktree, onCancel, onConfirm }: { ask: DeleteAsk; onRemoveWorktree(on: boolean): void; onCancel(): void; onConfirm(): void }) {
  const { info } = ask;
  return (
    <div role="group" aria-label="Delete this run permanently" data-esc-local onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), onCancel())} className="grid gap-2 border-t border-ws-sep bg-ws-bar px-3.5 py-2.5">
      <p className="m-0 text-ws-ink">Delete this run and its history from Gossamr? This can&apos;t be undone.</p>
      {!info ? (
        <p role="status" className="m-0 text-ws-ink3">
          Looking at its folder…
        </p>
      ) : info.removable ? (
        <label className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
          <input type="checkbox" checked={ask.removeWorktree} disabled={ask.busy} onChange={(ev) => onRemoveWorktree(ev.target.checked)} className="mt-1" />
          <span>
            Also remove its worktree folder{info.bytes !== null ? ` (${sizeText(info.bytes)})` : ""}
            <span className="selectable block font-mono text-xs text-ws-ink3 [overflow-wrap:anywhere]">{info.path}</span>
            <span className="block text-xs text-ws-ink3">Removed with claude rm, which refuses work that was never pushed. Only folders in ~/Gossamr/agents are ever removed.</span>
          </span>
        </label>
      ) : (
        <p className="m-0 text-ws-ink2">{info.reason}</p>
      )}
      {ask.refused && (
        <p role="alert" data-tone="error" className="selectable m-0 text-ws-danger [overflow-wrap:anywhere] whitespace-pre-wrap">
          Claude kept it: {ask.refused}. Nothing was deleted.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="dangerFill" autoFocus disabled={!info || ask.busy} onClick={onConfirm}>
          {ask.busy ? "Deleting…" : ask.removeWorktree ? "Delete run and remove folder" : "Delete permanently"}
        </Btn>
        <Btn tone="ghost" disabled={ask.busy} onClick={onCancel}>
          Keep it
        </Btn>
      </div>
    </div>
  );
}

export function ArchivedSectionView({ runs, open, now, ticketTitle, asking, onToggle, onRestore, onAskDelete, onCancelDelete, onRemoveWorktree, onConfirmDelete }: ArchivedSectionViewProps) {
  return (
    <section aria-label="Archived" data-archived className="grid gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className="m-0 text-xs font-semibold tracking-[0.05em] uppercase text-ws-ink2">Archived</h3>
        <span data-archived-count className="text-xs text-ws-ink3">
          {runs.length}
        </span>
        <span className="ml-1 text-sm text-ws-ink3">Out of Agents and Needs you. Restore one, or delete it for good.</span>
        <Button variant="plain" size="sm" className="ml-auto" aria-expanded={open} onClick={onToggle}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && (
        <div role="group" aria-label="Archived runs" className="overflow-hidden rounded-[10px] border border-ws-sep">
          {runs.map((run) => (
            <div key={run.id} data-archived-run={run.id} className="border-b border-ws-sep bg-ws-win last:border-b-0">
              <div className="flex items-center gap-3 px-3.5 py-2">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono text-sm font-semibold text-ws-ink2">{run.item?.key ?? "none"}</span> <span className="font-semibold">{runTitle(run, ticketTitle(run))}</span>
                </span>
                <time dateTime={run.archivedAt ?? undefined} className="shrink-0 text-sm text-ws-ink3 tabular-nums" title="Archived">
                  {ageText({ endedAt: run.archivedAt ?? null, queuedAt: run.queuedAt }, now)}
                </time>
                <Btn icon="retry" onClick={() => onRestore(run.id)}>
                  Restore
                </Btn>
                <Btn tone="danger" icon="x" disabled={!!asking} onClick={() => onAskDelete(run.id)} title="Deletes the run and its history from Gossamr">
                  Delete permanently
                </Btn>
              </div>
              {asking?.id === run.id && <DeletePanel ask={asking} onRemoveWorktree={onRemoveWorktree} onCancel={onCancelDelete} onConfirm={onConfirmDelete} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ArchivedSection({ runs, now }: { runs: readonly Run[]; now: number }) {
  const open = useRuns((s) => s.archivedOpen);
  const items = useWorkspace((s) => s.items);
  const [asking, setAsking] = useState<DeleteAsk | null>(null);
  if (runs.length === 0) return null;

  const ask = async (id: string) => {
    setAsking({ id, info: null, removeWorktree: false, busy: false, refused: null });
    try {
      const info = await useRuns.getState().backend?.runsWorktreeInfo(id);
      setAsking((a) => (a?.id === id && info ? { ...a, info } : a));
    } catch {
      setAsking((a) => (a?.id === id ? { ...a, info: { path: "", removable: false, reason: "Couldn't look at its folder, so only Gossamr's record can be deleted.", bytes: null } } : a));
    }
  };
  const confirm = async () => {
    if (!asking) return;
    setAsking({ ...asking, busy: true, refused: null });
    const result = await useRuns.getState().deleteArchived(asking.id, asking.removeWorktree);
    setAsking(result?.type === "refused" ? { ...asking, busy: false, refused: result.message } : null);
  };

  return (
    <ArchivedSectionView
      runs={runs}
      open={open}
      now={now}
      ticketTitle={(run) => (run.item ? (items[itemKey(run.item)]?.title ?? null) : null)}
      asking={asking}
      onToggle={() => useRuns.getState().setArchivedOpen(!open)}
      onRestore={(id) => void useRuns.getState().restore(id)}
      onAskDelete={(id) => void ask(id)}
      onCancelDelete={() => setAsking(null)}
      onRemoveWorktree={(removeWorktree) => setAsking((a) => (a ? { ...a, removeWorktree } : a))}
      onConfirmDelete={() => void confirm()}
    />
  );
}
