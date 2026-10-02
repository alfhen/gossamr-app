import { useState } from "react";
import type { AgentSettings, Run } from "../types";
import { Box, Btn, Sec, SheetFrame } from "./AgentSheet";
import { stoppable, KIND_LABEL } from "./agentsLogic";
import { COPY, MAY_TOUCH } from "./runSheetLogic";
import { Icon } from "./AgentIcons";

export interface CleanupOffer {
  count: number;
  reason: string;
  /** What the last clean-up did, in a sentence. */
  report: string | null;
  busy: boolean;
}

export interface SettingsViewProps {
  runs: readonly Run[];
  stopping: boolean;
  /** How many agents the app would leave running if it quit now. */
  keepRunning: number | null;
  /** Null until the backend has answered. */
  settings: AgentSettings | null;
  /** A save is under way; the fields wait so a second one can't send values from before the first. */
  settingsSaving?: boolean;
  cleanup: CleanupOffer | null;
  onSettings(next: AgentSettings): void;
  onCleanup(): void;
  onStopAll(): void;
  onClose(): void;
}

/** Safety and settings: Stop all, what agents can touch in plain words, and the few switches that exist. */
export function AgentsSettingsView({ runs, stopping, keepRunning, settings, settingsSaving = false, cleanup, onSettings, onCleanup, onStopAll, onClose }: SettingsViewProps) {
  const [asking, setAsking] = useState(false);
  const active = stoppable(runs);
  return (
    <SheetFrame label="Agents safety and settings" title="Agents" hint={<>safety and settings · <kbd className="font-sans">esc</kbd> close</>} wide={false} onClose={onClose}>
      <h2 className="m-0 text-[20px] leading-tight font-semibold">Safety and settings</h2>

      <Sec title="Stop everything">
        <Box>
          <p className="m-0">
            Stops every agent Gossamr started that is working or waiting, in every account. What each one already wrote stays in its worktree. Agents you started from Terminal are not touched.
          </p>
          {asking ? (
            <div
              role="group"
              aria-label="Stop all agents"
              data-esc-local
              className="flex flex-wrap items-center gap-2"
              onKeyDown={(ev) => {
                if (ev.key === "Escape") (ev.stopPropagation(), setAsking(false));
              }}
            >
              <span className="text-ws-ink2">
                Stop {active.length} {active.length === 1 ? "agent" : "agents"}?
              </span>
              <Btn tone="dangerFill" autoFocus onClick={() => (setAsking(false), onStopAll())}>
                Yes, stop {active.length === 1 ? "it" : "all"}
              </Btn>
              <Btn tone="ghost" onClick={() => setAsking(false)}>
                Keep going
              </Btn>
            </div>
          ) : (
            <div>
              <Btn tone="danger" icon="stop" disabled={active.length === 0 || stopping} onClick={() => setAsking(true)}>
                Stop all{active.length ? ` (${active.length})` : ""}
              </Btn>
            </div>
          )}
          {keepRunning !== null && keepRunning > 0 && <p className="m-0 text-sm text-ws-ink2">{keepRunning} {keepRunning === 1 ? "agent keeps" : "agents keep"} running if you quit Gossamr or sign out.</p>}
        </Box>
      </Sec>

      <Sec title="What agents can touch">
        <p className="m-0 text-ws-ink">{COPY.runAsYou}</p>
        <p className="m-0 text-ws-ink2">{COPY.notALock}</p>
        <ul className="m-0 grid list-none gap-1.5 p-0 text-ws-ink2">
          {MAY_TOUCH.map((t) => (
            <li key={t.title} data-tone={t.tone} className="grid grid-cols-[18px_minmax(0,1fr)] gap-1.5">
              <Icon name={t.tone === "yes" ? "check" : t.tone === "ask" ? "hand" : "x"} className={`mt-0.5 size-3.5 ${t.tone === "yes" ? "text-ws-done" : t.tone === "ask" ? "text-ws-warn" : "text-ws-ink3"}`} />
              <span>
                <b className="font-semibold text-ws-ink">{t.title}</b> {t.text}
              </span>
            </li>
          ))}
        </ul>
        <p className="m-0 text-ws-ink2">{COPY.receives.replace("below ", "in the setup sheet ")}</p>
        {active.length > 0 && (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="text-xs tracking-[0.05em] text-ws-ink3 uppercase">
                <th className="py-1 pr-2 font-semibold">Agent</th>
                <th className="py-1 font-semibold">Starts in</th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id} className="border-t border-ws-sep align-top">
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    <span className="font-mono font-semibold">{r.item?.key ?? "task"}</span> <span className="text-ws-ink3">{KIND_LABEL[r.spec.kind]}</span>
                  </td>
                  <td className="selectable py-1.5 font-mono text-sm break-all text-ws-ink2">{r.expectedWorktree}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sec>

      <Sec title="Limits">
        <Box>
          {settings ? <LimitsForm key={JSON.stringify(settings)} settings={settings} disabled={settingsSaving} onSave={onSettings} /> : <p className="m-0 text-ws-ink3">Loading…</p>}
          <p className="m-0 text-sm text-ws-ink2">Time counts from launch. Tokens are read every few seconds, so a run can pass its limit by a poll and a turn before it stops. Gossamr stops it the same way Stop does, and what it wrote stays in its worktree.</p>
          <p className="m-0 text-sm text-ws-ink2">A run that has been quiet for 30 minutes shows a chip. It is not stopped, and it does not count toward the number on the sidebar.</p>
        </Box>
      </Sec>

      <Sec title="Clean up">
        <Box>
          <p className="m-0 text-ws-ink2">Finished runs leave their worktree and session files behind. Clean up removes a worktree with claude rm, which refuses work that was never pushed and says why. Gossamr never forces it.</p>
          {cleanup ? (
            <div className="flex flex-wrap items-center gap-2">
              <Btn icon="folder" disabled={cleanup.busy} onClick={onCleanup}>
                {cleanup.busy ? "Cleaning up…" : `Clean up finished runs (${cleanup.count})`}
              </Btn>
              <span className="text-sm text-ws-ink3">{cleanup.reason}</span>
            </div>
          ) : (
            <p className="m-0 text-sm text-ws-ink3">Nothing is old or large enough to offer yet. Open a finished run to clean up just that one.</p>
          )}
          {cleanup?.report && (
            <p role="status" className="selectable m-0 text-sm text-ws-ink2 [overflow-wrap:anywhere]">
              {cleanup.report}
            </p>
          )}
        </Box>
      </Sec>

      <Sec title="Notifications and environment">
        <Box>
          <p className="m-0 text-ws-ink2">When an agent needs you, finishes or fails to start while Gossamr is in the background, you get a system notification that names the ticket. Click the window within 30 seconds and the run opens.</p>
          <p className="m-0 text-ws-ink2">Agents start with the environment of your own shell, read once when Gossamr opens, so they find the same tools you do.</p>
        </Box>
      </Sec>
    </SheetFrame>
  );
}

const FIELD = "w-20 rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-sm text-ws-ink";

/** Numbers are saved when the field is left or Enter is pressed, never per keystroke. */
function LimitsForm({ settings, disabled, onSave }: { settings: AgentSettings; disabled: boolean; onSave(next: AgentSettings): void }) {
  const [minutes, setMinutes] = useState(String(settings.wallClockMinutes));
  const [millions, setMillions] = useState(String(settings.tokenCap / 1_000_000));
  const whole = (text: string, fallback: number) => (Number.isFinite(Number(text)) && text.trim() !== "" ? Math.max(0, Number(text)) : fallback);
  const save = () => {
    const next = { ...settings, wallClockMinutes: Math.round(whole(minutes, settings.wallClockMinutes)), tokenCap: Math.round(whole(millions, settings.tokenCap / 1_000_000) * 1_000_000) };
    if (next.wallClockMinutes !== settings.wallClockMinutes || next.tokenCap !== settings.tokenCap) onSave(next);
  };
  const enter = (ev: React.KeyboardEvent) => ev.key === "Enter" && (ev.currentTarget as HTMLElement).blur();
  return (
    <div className="grid gap-2">
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-[210px]">Agents running at once</span>
        <select disabled={disabled} aria-label="Agents running at once" value={settings.maxRuns} onChange={(e) => onSave({ ...settings, maxRuns: Number(e.target.value) })} className={FIELD}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="text-sm text-ws-ink3">counted across accounts</span>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-[210px]">Stop a run after (minutes)</span>
        <input disabled={disabled} aria-label="Stop a run after this many minutes" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} onBlur={save} onKeyDown={enter} className={FIELD} />
        <span className="text-sm text-ws-ink3">0 is never</span>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-[210px]">Stop a run after (million tokens)</span>
        <input disabled={disabled} aria-label="Stop a run after this many million tokens" inputMode="decimal" value={millions} onChange={(e) => setMillions(e.target.value)} onBlur={save} onKeyDown={enter} className={FIELD} />
        <span className="text-sm text-ws-ink3">0 is never</span>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <input type="checkbox" disabled={disabled} checked={settings.draftOnFinish} onChange={(e) => onSave({ ...settings, draftOnFinish: e.target.checked })} />
        <span>Draft a Jira comment when an agent finishes</span>
        <span className="text-sm text-ws-ink3">only a draft, and only when it wrote a For Jira section</span>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-[210px]">Open sessions in</span>
        <select disabled={disabled} aria-label="Terminal app" value={settings.terminal} onChange={(e) => onSave({ ...settings, terminal: e.target.value as AgentSettings["terminal"] })} className={FIELD.replace("w-20", "w-32")}>
          <option value="terminal">Terminal</option>
          <option value="iTerm">iTerm</option>
        </select>
      </label>
    </div>
  );
}
