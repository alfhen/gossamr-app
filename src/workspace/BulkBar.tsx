export interface BulkBarProps {
  count: number;
  targets: { name: string; count: number }[];
  approvable: { id: string; key: string; from: string; to: string }[];
  confirming: boolean;
  onMoveAll(name: string): void;
  onAsk(): void;
  onCancel(): void;
  onApprove(): void;
  onClear(): void;
}

/** Actions on the ticked cards. Approval is offered for transition drafts only, after a look at each move. */
export function BulkBar(p: BulkBarProps) {
  return (
    <div role="toolbar" aria-label="Bulk actions" className="border-t border-ws-sep bg-ws-bar px-4 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">{p.count} selected</span>
        <label className="flex items-center gap-2 text-ws-ink2">
          <span className="sr-only">Move all to</span>
          <select
            value=""
            aria-label="Move all to"
            onChange={(ev) => ev.target.value && p.onMoveAll(ev.target.value)}
            className="rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink"
          >
            <option value="">Move all to…</option>
            {p.targets.map((t) => (
              <option key={t.name} value={t.name}>
                {t.count < p.count ? `${t.name} (${t.count} of ${p.count})` : t.name}
              </option>
            ))}
          </select>
        </label>
        {p.approvable.length > 0 && !p.confirming && (
          <button type="button" onClick={p.onAsk} className="rounded-md border border-ws-pip px-2.5 py-1 font-semibold text-ws-pip hover:bg-ws-pip hover:text-ws-on-pip">
            Approve {p.approvable.length} move{p.approvable.length === 1 ? "" : "s"}…
          </button>
        )}
        <button type="button" onClick={p.onClear} className="ml-auto text-ws-ink3 underline hover:text-ws-ink">
          Clear
        </button>
      </div>
      {p.confirming && (
        <div role="group" aria-label="Confirm bulk approval" className="mt-2 rounded-lg border border-ws-pip bg-ws-pip-soft p-3">
          <p className="mb-1 font-semibold">These change the tickets in your tracker:</p>
          <ul className="mb-2 font-mono text-sm text-ws-ink2">
            {p.approvable.map((a) => (
              <li key={a.id}>
                {a.key}: {a.from} → {a.to}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" onClick={p.onApprove} className="rounded-md bg-ws-pip px-3 py-1 font-semibold text-ws-on-pip">
              Approve all {p.approvable.length}
            </button>
            <button type="button" onClick={p.onCancel} className="rounded-md border border-ws-sep2 px-3 py-1">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
