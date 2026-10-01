import { useState } from "react";
import type { Run } from "../types";
import { Box, Btn, Sec, SheetFrame } from "./AgentSheet";
import { stoppable, KIND_LABEL } from "./agentsLogic";
import { COPY, MAY_TOUCH } from "./runSheetLogic";
import { Icon } from "./AgentIcons";

export interface SettingsViewProps {
  runs: readonly Run[];
  stopping: boolean;
  /** How many agents the app would leave running if it quit now. */
  keepRunning: number | null;
  cap: number;
  onStopAll(): void;
  onClose(): void;
}

/** Safety and settings: Stop all, what agents can touch in plain words, and the few switches that exist. */
export function AgentsSettingsView({ runs, stopping, keepRunning, cap, onStopAll, onClose }: SettingsViewProps) {
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
          <p className="m-0">
            Gossamr starts at most <b className="font-semibold">{cap}</b> agents at once, counted across accounts. This is fixed for now.
          </p>
          <p className="m-0 text-sm text-ws-ink2">A run that has been quiet for 30 minutes shows a chip. It is not stopped, and it does not count toward the number on the sidebar.</p>
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
