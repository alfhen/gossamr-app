import { SwitchRow } from "../components/Switch";
import { MAX_PASSES, useManager } from "./managerProto";

const ALWAYS_ASKS = ["Building code", "Pushing a branch", "Writing to Jira: comments, tickets, moves, subtasks"];

/** The prototype switch. It reloads because the sample data it shows (tickets, runs) is chosen when the app starts. */
export function ManagerPrototypeSwitch() {
  const on = useManager((s) => s.on);
  return (
    <SwitchRow
      label="Prototype: Pip manager"
      description="Swaps in a scripted set of tickets and agent runs, a Waiting for you view and a scenario bar, so you can try Pip as a manager. Reloads the sample data. Nothing real is sent."
      checked={on}
      onChange={(next) => {
        useManager.getState().setOn(next);
        location.reload();
      }}
    />
  );
}

/** What Pip as manager may do on its own. Everything that changes something outside Gossamr stays a draft. */
export function ManagerSettingsSection() {
  const s = useManager();
  return (
    <div className="grid gap-3.5">
      <SwitchRow
        label="Pip reviews finished runs"
        description="When a run finishes, Gossamr tells Pip. Pip reads the result, drafts a comment, a breakdown or a follow-up if one is useful, and stays quiet when there is nothing to do."
        checked={s.reviewFinished}
        onChange={(reviewFinished) => s.change({ reviewFinished })}
      />
      <div className="grid gap-2">
        <SwitchRow
          label="Pip may send read-only runs back automatically"
          description="If a read-only run missed part of the job, Pip may send it back for another pass without asking. Never for a run that can build or push."
          checked={s.autoSendBack}
          disabled={!s.reviewFinished}
          onChange={(autoSendBack) => s.change({ autoSendBack })}
        />
        <label className="flex items-center gap-2 pl-0.5 text-ws-ink2">
          Most passes per run
          <select aria-label="Most passes per run" value={s.maxPasses} disabled={!s.reviewFinished || !s.autoSendBack} onChange={(ev) => s.change({ maxPasses: Number(ev.target.value) })} className="ws-select">
            {Array.from({ length: MAX_PASSES }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <SwitchRow
        label="Pip proposes runs from chat"
        description="Ask Pip to look into something and it drafts a read-only investigation, with the prompt for you to read and edit. Nothing starts until you press Start."
        checked={s.proposeFromChat}
        onChange={(proposeFromChat) => s.change({ proposeFromChat })}
      />
      <div>
        <h3 className="m-0 mb-1 text-sm font-semibold tracking-[0.05em] text-ws-ink3 uppercase">Always asks you</h3>
        <ul aria-label="Always asks you" className="m-0 grid list-none gap-1 p-0">
          {ALWAYS_ASKS.map((a) => (
            <li key={a} className="flex items-center gap-2 text-ws-ink2">
              <span aria-hidden className="text-ws-done">
                ✓
              </span>
              {a}
              <span className="ml-auto rounded-full bg-ws-sel px-2 text-xs text-ws-ink3">always asks you</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
