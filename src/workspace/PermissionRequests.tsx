import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { movedWithin, repeatOnOther, trackMoves } from "./buttonMoves";
import { inputLineCount } from "./permissionInput";
import { Button } from "../components/Button";
import { ButtonGroup } from "../components/ButtonGroup";
import { labelsByRun } from "../lib/workstreamStage";
import type { PermissionRequest, Run } from "../types";
import { CodeBox } from "./AgentSheet";
import { PERMISSIONS_WARNING, answeringKey, canAllow, denyOnlyWhy, openPermissions, permissionWants, runAnswerPending } from "./permissionLogic";
import { RequestInput } from "./RequestInput";
import { useRuns } from "./runsStore";

type Size = "sm" | "md";

/** What the agent is called in a request: its label in the workstream, else "The agent". */
function useAgentName(run: Run, label?: string) {
  const runs = useRuns((s) => s.runs);
  return useMemo(() => label ?? labelsByRun(runs).get(run.id) ?? "The agent", [label, runs, run.id]);
}

/**
 * One open request with Allow and Deny. Neither is the default: nothing takes the keyboard, neither is the prominent style,
 * and Enter on the card around it opens the run, so allowing takes a deliberate press.
 */
export function PermissionItem({ run, request, label, size }: { run: Run; request: PermissionRequest; label?: string; size?: Size }) {
  const name = useAgentName(run, label);
  const key = answeringKey(run.id, request.id);
  const answering = useRuns((s) => s.permissionAnswering.get(key));
  const answered = useRuns((s) => s.permissionAnswered.has(key));
  const pending = useRuns((s) => runAnswerPending(run.id, openPermissions(run), s.permissionAnswering, s.permissionAnswered));
  const refused = useRuns((s) => s.permissionRefused.get(key) ?? null);
  // Any change to a request anywhere on the page moves what is below it, so every item waits after one.
  const epoch = useRuns((s) => s.permissionEpoch);
  const settled = useSettled(`${epoch}\u0000${run.id}\u0000${openPermissions(run).map((p) => p.id).join(",")}`);
  const regain = useRef<(() => void) | null>(null);
  // An item answered from the keyboard leaves; the keyboard goes to the list it was in, never to the next item's button.
  useEffect(() => () => void (regain.current && setTimeout(regain.current, 0)), []);
  const onAnswer = (decision: "allow" | "deny", from: HTMLElement) => {
    const keyboard = document.activeElement === from;
    const home = from.closest<HTMLElement>("[data-permission-requests], article[data-run-id], #agent-sheet, [data-needs-pane]");
    const back = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      (home?.isConnected ? home : from.isConnected ? from : null)?.focus({ preventScroll: true });
    };
    if (keyboard) regain.current = back;
    void useRuns
      .getState()
      .answerPermission(run.id, request.id, decision)
      .then((ok) => {
        if (ok) return;
        regain.current = null;
        if (keyboard) setTimeout(() => (document.activeElement === document.body || !document.activeElement) && from.focus({ preventScroll: true }), 0);
      });
  };
  const held = answered || pending ? "Wait a moment: an answer is on its way." : settled ? null : "Wait a moment: the list just changed.";
  return <PermissionItemView name={name} request={request} answering={answering ?? null} held={held} refused={refused} size={size} onAnswer={onAnswer} />;
}

/**
 * How long an item's buttons wait after it appears or its run's requests change. Half a second outlasts the second click
 * of a double-click, which comes a few hundred milliseconds after the first, and the wait starts only once the first
 * answer is back; reading the request that moved up takes longer than that anyway.
 */
export const SETTLE_MS = 500;

/**
 * False for `SETTLE_MS` after `key` changes. When an answered request leaves, what was below it moves up under the
 * pointer; its buttons wake only after the second click of a double-click would have landed.
 */
function useSettled(key: string) {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return settled === key;
}

/**
 * An answer button that takes only a click aimed at it: not the second click of a double-click, not a click on a button
 * that moved on screen within `SETTLE_MS`, and not a click at the spot of one a moment before that landed on something
 * else. A key press acts on the focused button wherever it sits.
 */
function AnswerButton({ size, off, title, onAnswer, children }: { size: Size; off: boolean; title?: string; onAnswer(from: HTMLElement): void; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [moved, setMoved] = useState(0);
  // A move holds the button where you can see it, as a change to the list does.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = trackMoves(el, () => {
      setMoved((n) => n + 1);
      clearTimeout(timer);
      timer = setTimeout(() => setMoved(0), SETTLE_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);
  const held = off || moved > 0;
  return (
    <Button
      ref={ref}
      size={size}
      disabled={held}
      title={off ? title : moved > 0 ? "Wait a moment: the list just changed." : undefined}
      onClick={(ev) => {
        const el = ev.currentTarget;
        if (ev.detail > 1 || (ev.detail === 1 && (movedWithin(el, SETTLE_MS) || repeatOnOther(el, REPEAT_MS)))) return;
        onAnswer(el);
      }}
    >
      {children}
    </Button>
  );
}

/** How long after a click a second one at the same spot, on what moved under it, is ignored. */
export const REPEAT_MS = 1000;

/** Lines from which an item also offers Deny at its top and says where Allow is. */
export const LONG_REQUEST_LINES = 40;

export function PermissionItemView({ name, request, answering, held = null, refused = null, size = "md", onAnswer }: { name: string; request: PermissionRequest; answering: "allow" | "deny" | null; held?: string | null; refused?: string | null; size?: Size; onAnswer(decision: "allow" | "deny", from: HTMLElement): void }) {
  const why = denyOnlyWhy(request);
  const off = !!answering || !!held;
  const title = held ?? undefined;
  const length = request.input != null ? inputLineCount(request.kind, request.input) : 0;
  return (
    <div data-permission-request={request.id} className="grid gap-2">
      <p className="m-0 font-semibold text-ws-ink">
        {name} wants to {permissionWants(request)}
      </p>
      {/* Denying unseen is safe, so a long request offers Deny before it too; Allow stays after all of it. */}
      {length > LONG_REQUEST_LINES && (
        <div data-permission-top className="flex flex-wrap items-center gap-2" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
          <p className="m-0 text-sm text-ws-ink2">{`This request is ${length.toLocaleString("en")} lines long. Allow is at its end.`}</p>
          <AnswerButton size={size} off={off} title={title} onAnswer={(el) => onAnswer("deny", el)}>
            Deny
          </AnswerButton>
        </div>
      )}
      {request.tool && (
        <p className="m-0 text-sm text-ws-ink2">
          With <code className="font-mono">{request.tool}</code>:
        </p>
      )}
      {/* Every field of what an allow passes the agent, not only its heading. */}
      {request.input != null ? <RequestInput kind={request.kind} input={request.input} /> : request.subject && <CodeBox text={request.subject} what="the request" wrap />}
      {request.kind === "permissions" && <p className="m-0 text-sm font-semibold text-ws-warn">{PERMISSIONS_WARNING}</p>}
      {why && <p className="m-0 text-sm text-ws-ink2">{why}</p>}
      {refused && (
        <p role="status" className="m-0 text-sm text-ws-blocked">
          Not answered: {refused}
        </p>
      )}
      {/* After the whole request, never beside it or sticky: Allow is reached only by passing all of it. The card behind
          takes a click or Enter as opening the run; these buttons are answers of their own. */}
      <div data-permission-answers onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
        <ButtonGroup label="Answer the permission request">
          {canAllow(request) && (
            <AnswerButton size={size} off={off} title={title} onAnswer={(el) => onAnswer("allow", el)}>
              {answering === "allow" ? "Allowing…" : "Allow"}
            </AnswerButton>
          )}
          <AnswerButton size={size} off={off} title={title} onAnswer={(el) => onAnswer("deny", el)}>
            {answering === "deny" ? "Denying…" : "Deny"}
          </AnswerButton>
        </ButtonGroup>
      </div>
    </div>
  );
}

/** Every open request of a run, oldest first, each answered on its own; `except` is one Needs you shows. */
export function PermissionRequests({ run, label, size, except }: { run: Run; label?: string; size?: Size; except?: string }) {
  return (
    <div data-permission-requests tabIndex={-1} className="grid gap-3 outline-none">
      {openPermissions(run)
        .filter((request) => request.id !== except)
        .map((request) => (
        <PermissionItem key={request.id} run={run} request={request} label={label} size={size} />
      ))}
    </div>
  );
}
