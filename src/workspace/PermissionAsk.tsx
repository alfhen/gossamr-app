import { useEffect, useMemo, useRef } from "react";
import { labelsByRun } from "../lib/workstreamStage";
import type { Run } from "../types";
import { Btn, CodeBox } from "./AgentSheet";
import { permissionRequest } from "./agentsLogic";
import { useRuns } from "./runsStore";

export const PERMISSION_NOTE = "Claude Code asks in its own prompt, so you answer it in Terminal.";

/** Moves focus to the first decision button when it is on the sheet itself, as it is on opening; a click elsewhere is not stolen. */
export function focusDecision(root: Pick<Element, "closest" | "querySelector"> | null, active: Element | null) {
  const sheet = root?.closest("#agent-sheet");
  if (sheet && active === sheet) root?.querySelector<HTMLButtonElement>("[data-permission-decisions] button:not(:disabled)")?.focus({ preventScroll: true });
}

/** A run at a permission prompt: the command it asked about, and the way to answer it in Terminal. */
export function PermissionAsk({ run, onAttach, label }: { run: Run; onAttach(): void; label?: string }) {
  const runs = useRuns((s) => s.runs);
  const name = useMemo(() => label ?? labelsByRun(runs).get(run.id) ?? "Claude", [label, runs, run.id]);
  const ask = permissionRequest(run.needs);
  const root = useRef<HTMLDivElement>(null);
  // Opened from Needs you, the sheet has focus on itself; the answer is what the person came for, so the keyboard starts there.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusDecision(root.current, document.activeElement));
    return () => cancelAnimationFrame(frame);
  }, [run.id]);
  const what = !ask?.tool ? `${name} is asking permission:` : ask.tool === "Bash" ? `${name} wants to run this command:` : `${name} wants to use ${ask.tool} on:`;
  return (
    <div ref={root} data-permission-ask className="grid gap-2">
      <p className="m-0 font-semibold text-ws-ink">{what}</p>
      {ask ? <CodeBox text={ask.command} what="the command" wrap /> : <p className="m-0 text-ws-ink2">It didn&apos;t say what.</p>}
      <p className="m-0 text-sm text-ws-ink2">{PERMISSION_NOTE}</p>
      {/* The card behind takes a click or Enter as opening the run; this button is an answer of its own. */}
      <div data-permission-decisions className="flex flex-wrap items-center gap-2" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
        <Btn tone="primary" icon="term" disabled={!run.shortId} title={run.shortId ? undefined : "There is no session to open yet"} onClick={onAttach}>
          Open in Terminal
        </Btn>
      </div>
    </div>
  );
}
