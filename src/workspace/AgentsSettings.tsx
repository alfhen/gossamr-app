import { useState } from "react";
import { DIGEST_MINUTES, type AgentSettings, type NoticeMode, type Run } from "../types";
import { Box, Btn, Sec, SheetFrame } from "./AgentSheet";
import { roleLabel } from "../lib/roles";
import { slotWaiters, stopAllLabel, stopAllText, stoppable } from "./agentsLogic";
import { SAFETY_SUMMARY } from "./runSheetLogic";
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
  const waiting = slotWaiters(runs);
  const reach = active.length + waiting.length;
  return (
    <SheetFrame
      label="Agents safety and settings"
      title="Agents"
      hint={<>safety and settings · <kbd className="font-sans">esc</kbd> close</>}
      wide={false}
      onClose={onClose}
    >
      <h2 className="m-0 text-[20px] leading-tight font-semibold">Safety and settings</h2>
      <ul data-safety-summary className="m-0 grid list-none gap-1.5 p-0">
        {SAFETY_SUMMARY.map((t) => (
          <li key={t.text} className="grid grid-cols-[18px_minmax(0,1fr)] gap-1.5 text-ws-ink">
            <Icon name={t.icon} className="mt-0.5 size-3.5 text-ws-ink2" />
            <span>{t.text}</span>
          </li>
        ))}
      </ul>

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
                Stop {stopAllText(active.length, waiting.length)}?
              </span>
              <Btn tone="dangerFill" autoFocus onClick={() => (setAsking(false), onStopAll())}>
                Yes, stop {reach === 1 ? "it" : "all"}
              </Btn>
              <Btn tone="ghost" onClick={() => setAsking(false)}>
                Keep going
              </Btn>
            </div>
          ) : (
            <div>
              <Btn tone="danger" icon="stop" disabled={reach === 0 || stopping} onClick={() => setAsking(true)}>
                {stopAllLabel(reach)}
              </Btn>
            </div>
          )}
          {keepRunning !== null && keepRunning > 0 && <p className="m-0 text-sm text-ws-ink2">{keepRunning} {keepRunning === 1 ? "agent keeps" : "agents keep"} running if you quit Gossamr or sign out.</p>}
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
                      <span className="font-mono font-semibold">{r.item?.key ?? "task"}</span> <span className="text-ws-ink3">{roleLabel(r.spec.role)}</span>
                    </td>
                    <td className="selectable py-1.5 font-mono text-sm break-all text-ws-ink2">{r.expectedWorktree}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Box>
      </Sec>

      <Sec title="Agents">
        <Box>
          {settings ? <AgentsForm key={JSON.stringify(settings)} settings={settings} disabled={settingsSaving} onSave={onSettings} /> : <p className="m-0 text-ws-ink3">Loading…</p>}
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
          {settings ? <NotificationsForm key={JSON.stringify(settings)} settings={settings} disabled={settingsSaving} onSave={onSettings} /> : <p className="m-0 text-ws-ink3">Loading…</p>}
          <p className="m-0 text-ws-ink2">While Gossamr is in the background you get a system notification when a workstream starts waiting on you, and one when its runs finish or fail, with a count. Click the window within 30 seconds and the one that waits longest opens.</p>
          <p className="m-0 text-ws-ink2">Agents start with the environment of your own shell, read once when Gossamr opens, so they find the same tools you do.</p>
        </Box>
      </Sec>
    </SheetFrame>
  );
}

const FIELD = "w-20 rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-sm text-ws-ink";

/** How many agents run at once, whether a finished one drafts a comment, and the terminal that opens sessions. */
function AgentsForm({ settings, disabled, onSave }: { settings: AgentSettings; disabled: boolean; onSave(next: AgentSettings): void }) {
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

const NOTICE_MODES: readonly { value: NoticeMode; label: string }[] = [
  { value: "workstream", label: "Each workstream" },
  { value: "digest", label: "Digest" },
  { value: "off", label: "Off" },
];

/** The settings with the digest interval read from `text`, or null when it says nothing new (or nothing a number). It stays between 1 minute and a day. */
export function withDigestMinutes(settings: AgentSettings, text: string): AgentSettings | null {
  const n = Number(text);
  if (text.trim() === "" || !Number.isFinite(n)) return null;
  const minutes = Math.min(1_440, Math.max(1, Math.round(n)));
  return minutes === (settings.digestMinutes ?? DIGEST_MINUTES) ? null : { ...settings, digestMinutes: minutes };
}

/** Which system notifications to show: one per workstream that starts waiting on you, a digest every so often, or none. */
function NotificationsForm({ settings, disabled, onSave }: { settings: AgentSettings; disabled: boolean; onSave(next: AgentSettings): void }) {
  const mode = settings.notifications ?? "workstream";
  const [minutes, setMinutes] = useState(String(settings.digestMinutes ?? DIGEST_MINUTES));
  const save = () => {
    const next = withDigestMinutes(settings, minutes);
    if (next) onSave(next);
    else setMinutes(String(settings.digestMinutes ?? DIGEST_MINUTES));
  };
  return (
    <div className="grid gap-2">
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-[210px]">Notifications</span>
        <select disabled={disabled} aria-label="Notifications" value={mode} onChange={(e) => onSave({ ...settings, notifications: e.target.value as NoticeMode })} className={FIELD.replace("w-20", "w-40")}>
          {NOTICE_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="text-sm text-ws-ink3">
          {mode === "workstream" ? "one when a workstream starts waiting on you, none while it already does" : mode === "digest" ? "one summary of the workstreams that wait on you" : "no system notifications about agents"}
        </span>
      </label>
      {mode === "digest" && (
        <label className="flex flex-wrap items-center gap-2">
          <span className="min-w-[210px]">Digest every (minutes)</span>
          <input
            disabled={disabled}
            aria-label="Digest every this many minutes"
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            onBlur={save}
            onKeyDown={(ev) => ev.key === "Enter" && ev.currentTarget.blur()}
            className={FIELD}
          />
          <span className="text-sm text-ws-ink3">at most one notification in that time</span>
        </label>
      )}
    </div>
  );
}
