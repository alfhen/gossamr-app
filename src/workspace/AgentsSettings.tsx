import { useState } from "react";
import { type AgentSettings, type Run, type WorkFolderGit } from "../types";
import { Box, Btn, Sec, SheetFrame } from "./AgentSheet";
import { Icon } from "./AgentIcons";
import { roleLabel } from "../lib/roles";
import { slotWaiters, stopAllLabel, stopAllText, stoppable } from "./agentsLogic";

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
  /** Who git commits as in the work folder: undefined until it is read, null when git couldn't be asked. */
  workFolder?: WorkFolderGit | null;
  /** A save is under way; the fields wait so a second one can't send values from before the first. */
  settingsSaving?: boolean;
  cleanup: CleanupOffer | null;
  onSettings(next: AgentSettings): void;
  onRevealWorkFolder(): void;
  onCleanup(): void;
  onStopAll(): void;
  onClose(): void;
}

/** Agent settings: Stop all, what agents can touch in plain words, and the few switches that exist. */
export function AgentsSettingsView({ runs, stopping, keepRunning, settings, workFolder, settingsSaving = false, cleanup, onSettings, onRevealWorkFolder, onCleanup, onStopAll, onClose }: SettingsViewProps) {
  const [asking, setAsking] = useState(false);
  const active = stoppable(runs);
  const waiting = slotWaiters(runs);
  const reach = active.length + waiting.length;
  return (
    <SheetFrame
      label="Agent settings"
      title="Agents"
      hint={<>settings · <kbd className="font-sans">esc</kbd> close</>}
      wide={false}
      onClose={onClose}
    >
      <h2 className="font-display m-0 text-[20px] leading-tight font-semibold">Agent settings</h2>
      <Sec title="Stop everything">
        <Box>
          <p className="m-0">Stops every agent Gossamr started, in every account. What each wrote stays in its worktree.</p>
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
                <tr className="text-sm font-semibold text-ws-ink2">
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
        </Box>
      </Sec>

      <Sec title="Where agents work">
        <WorkFolder git={workFolder} onReveal={onRevealWorkFolder} />
      </Sec>

      <Sec title="Clean up">
        <Box>
          <p className="m-0 text-ws-ink2">Removes finished runs' worktrees with claude rm, which refuses work that was never pushed.</p>
          {cleanup ? (
            <div className="flex flex-wrap items-center gap-2">
              <Btn icon="folder" disabled={cleanup.busy} onClick={onCleanup}>
                {cleanup.busy ? "Cleaning up…" : `Clean up finished runs (${cleanup.count})`}
              </Btn>
              <span className="text-sm text-ws-ink3">{cleanup.reason}</span>
            </div>
          ) : (
            <p className="m-0 text-sm text-ws-ink3">Nothing old or large enough yet. Open a finished run to clean up just that one.</p>
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

export const INCLUDE_IF_WARNING = "Your git settings choose an address by folder. Add a rule for ~/Gossamr/agents/<owner>/ to use it in Gossamr's clones too.";

const LINE = "m-0 border-b border-ws-sep py-2.5 first:pt-0";

const NO_EMAIL = "Git has no email address set for commits there.";

/** One line for each owner's clones, or the global address while there is no clone to read it in. */
function commitLines(git: WorkFolderGit): string[] {
  if (git.owners.length > 0) return git.owners.map((o) => (o.commitEmail ? `In ~/Gossamr/agents/${o.owner}/ git commits as ${o.commitEmail}.` : `In ~/Gossamr/agents/${o.owner}/ git has no email address set for commits.`));
  return [git.globalEmail ? `Git commits there as ${git.globalEmail}, your global address. Gossamr checks again inside a clone once it has made one.` : NO_EMAIL];
}

/** Where agents work, who git commits as there, and the way to see the folder. */
function WorkFolder({ git, onReveal }: { git: WorkFolderGit | null | undefined; onReveal(): void }) {
  return (
    <div className="grid">
      <p className={`${LINE} text-ws-ink2`}>
        Agents work in Gossamr&apos;s own clones in ~/Gossamr/agents, one per repository, each agent in its own worktree and branch. Gossamr clones a repository the first time an agent works on it, and fetches before each agent starts. Your clones in ~/Code and other folders aren&apos;t used or changed, so Claude Code, T3 Code and your own work there stay apart.
      </p>
      {git === null && <p className={`${LINE} text-ws-ink2`}>Gossamr couldn&apos;t ask git who commits there.</p>}
      {git &&
        commitLines(git).map((line) => (
          <p key={line} data-commit-address className={`${LINE} selectable text-ws-ink2 [overflow-wrap:anywhere]`}>
            {line}
          </p>
        ))}
      {git?.includeIf && (
        <p role="note" data-include-if className={`${LINE} flex items-start gap-1.5 text-ws-ink`}>
          <Icon name="alert" className="mt-0.5 size-[15px] shrink-0 text-ws-warn" />
          {INCLUDE_IF_WARNING}
        </p>
      )}
      <div className="pt-2.5">
        <Btn icon="folder" onClick={onReveal}>
          Reveal in Finder
        </Btn>
      </div>
    </div>
  );
}

const FIELD = "w-20 rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-sm text-ws-ink";

/** How many agents run at once and the terminal that opens sessions. */
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
        <span className="min-w-[210px]">Open sessions in</span>
        <select disabled={disabled} aria-label="Terminal app" value={settings.terminal} onChange={(e) => onSave({ ...settings, terminal: e.target.value as AgentSettings["terminal"] })} className={FIELD.replace("w-20", "w-32")}>
          <option value="terminal">Terminal</option>
          <option value="iTerm">iTerm</option>
        </select>
      </label>
    </div>
  );
}

/** System notices for new things in Needs you. */
function NotificationsForm({ settings, disabled, onSave }: { settings: AgentSettings; disabled: boolean; onSave(next: AgentSettings): void }) {
  return (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-[210px]">Notifications</span>
      <input type="checkbox" aria-label="Notifications" disabled={disabled} checked={settings.notifications !== "off"} onChange={(e) => onSave({ ...settings, notifications: e.target.checked ? "workstream" : "off" })} />
      <span className="text-sm text-ws-ink3">New things in Needs you</span>
    </label>
  );
}
