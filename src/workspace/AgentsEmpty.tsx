const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover";

export function AgentsEmpty() {
  return <p className="m-0 py-10 text-center text-ws-ink3">No agents yet. Ask Pip to start one.</p>;
}

export function NoMatch({ hidden, onClear }: { hidden: number; onClear(): void }) {
  return (
    <p className="m-0 flex items-center justify-center gap-3 py-10 text-ws-ink3">
      {hidden} {hidden === 1 ? "run is" : "runs are"} hidden by the filter.
      <button type="button" onClick={onClear} className={BUTTON}>
        Clear filter
      </button>
    </p>
  );
}
