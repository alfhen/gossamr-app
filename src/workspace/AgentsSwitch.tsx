export interface AgentsSwitchProps {
  enabled: boolean;
  pending: boolean | null;
  error: string | null;
  note: string | null;
  onChange(on: boolean): void;
}

/** What the switch shows: the backend's answer, or the value being asked for while it works. */
export function switchView({ enabled, pending, error }: Pick<AgentsSwitchProps, "enabled" | "pending" | "error">) {
  const checked = pending ?? enabled;
  const status = pending === true ? "Turning on. Reading your shell environment…" : pending === false ? "Turning off…" : error ? `Couldn't turn Agents ${checked ? "off" : "on"}: ${error}` : null;
  return { checked, busy: pending !== null, status, failed: pending === null && !!error };
}

export function AgentsSwitch(props: AgentsSwitchProps) {
  const { checked, busy, status, failed } = switchView(props);
  return (
    <div className="grid gap-1.5">
      <label className="flex items-start gap-2.5">
        <input type="checkbox" checked={checked} disabled={busy} onChange={(ev) => props.onChange(ev.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-semibold">Turn on Agents</span>
          <span className="block text-ws-ink3">A preview. Agents are Claude Code sessions that work in the background, and nothing starts until you approve it.</span>
        </span>
      </label>
      {status && (
        <p role={failed ? "alert" : "status"} data-tone={failed ? "error" : "busy"} className={`m-0 pl-[26px] ${failed ? "text-ws-danger" : "text-ws-ink2"}`}>
          {status}
        </p>
      )}
      {!status && props.note && (
        <p role="status" className="m-0 pl-[26px] text-ws-ink2">
          {props.note}
        </p>
      )}
    </div>
  );
}
