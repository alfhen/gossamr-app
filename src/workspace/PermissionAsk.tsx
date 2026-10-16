import { useEffect, useId, useMemo, useRef, useState } from "react";
import { permissionOffer, readAs } from "../lib/permission";
import { labelsByRun } from "../lib/workstreamStage";
import type { Run } from "../types";
import { Icon } from "./AgentIcons";
import { Btn, CodeBox } from "./AgentSheet";
import { usePrefs } from "./prefs";
import { permissionConfirmation, useRuns, type PermissionAnswered } from "./runsStore";

/** The one honest line beside Allow once: Gossamr can't say yes for the person, Claude Code's own prompt can. */
export const ALLOW_ONCE_NOTE = "Claude Code takes a yes only in its own prompt. Allow once opens this run in Terminal and copies the command: choose Yes there for this command only.";
/** The one-time explainer, above the first permission prompt's buttons, until the person says Got it. */
export const EXPLAINER_ALLOW = "Allow once in Terminal records your choice, opens this run in Terminal with the exact command copied, and you confirm there. Nothing runs until you do.";
export const EXPLAINER_DENY = "Deny tells the agent no, and it carries on without it.";
export const DENY_NOTE = "Claude is told you said no and carries on without it.";
/** Why a read-only run's card has Deny and nothing to allow. */
export const READ_ONLY_STEP_NOTE = "This is a read-only step, so it can't be allowed. Deny lets it carry on without it.";
export const STOP_LABEL = "Stop the run (abandons it)";
export const DENIED_TEXT = "Denied. Claude is carrying on without it.";

/** What the confirmation says once the person answered. */
export const confirmationText = (a: Pick<PermissionAnswered, "kind" | "copied">) =>
  a.kind === "denied" ? DENIED_TEXT : a.copied ? "Opened in Terminal, command copied. Choose Yes there for this command only." : "Opened in Terminal. Choose Yes there for this command only.";

/**
 * The line that says the person's answer to a permission prompt went through. The button pressed has gone, so the
 * keyboard lands here rather than on the page, as `AnswerSent` does.
 */
export function PermissionSent({ answered }: { answered: Pick<PermissionAnswered, "kind" | "copied"> }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected) line.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <p ref={line} tabIndex={-1} role="status" data-permission-sent={answered.kind} className="m-0 flex items-center gap-1.5 text-sm font-semibold text-ws-pip outline-none">
      <Icon name="check" className="size-3.5" />
      {confirmationText(answered)}
    </p>
  );
}

/** What Allow once and Deny do, said once: on the first permission prompt the person sees, until Got it (kept in the prefs, as the orientation card's is). */
export function PermissionExplainer({ allow, onDismiss = () => usePrefs.getState().setPermissionExplainerSeen(true) }: { allow: boolean; onDismiss?(): void }) {
  const box = useRef<HTMLElement>(null);
  // The button pressed goes with the explainer, so the keyboard lands on the prompt's own first answer, not nowhere.
  const dismiss = () => {
    const ask = box.current?.closest("[data-permission-ask]");
    onDismiss();
    requestAnimationFrame(() => ask?.querySelector<HTMLElement>("[data-permission-decisions] button:not(:disabled)")?.focus({ preventScroll: true }));
  };
  return (
    <section ref={box} data-permission-explainer aria-label={allow ? "What Allow once and Deny do" : "What Deny does"} className="grid gap-1 rounded-md border border-ws-sep bg-ws-bar px-2.5 py-2 text-sm text-ws-ink2">
      <p className="m-0 font-semibold text-ws-ink">First permission prompt? {allow ? "What the buttons do" : "What Deny does"}</p>
      {allow && <p className="m-0">{EXPLAINER_ALLOW}</p>}
      <p className="m-0">{EXPLAINER_DENY}</p>
      <div>
        <Btn tone="plain" onClick={dismiss}>
          Got it
        </Btn>
      </div>
    </section>
  );
}

/** The confirmation of a run's answered permission prompt from the store, while it still applies. */
export function usePermissionConfirmation(run: Run): PermissionAnswered | null {
  const answered = useRuns((s) => s.permissionAnswered[run.id]);
  return permissionConfirmation(run, answered);
}

/** What a card asks before Stop abandons the run, as the sheet asks before its own Stop. */
export const stopRunQuestion = (name: string) => `Stop ${name}? It abandons the run.`;

/** The card's confirm step for Stop: one click from Deny must not abandon the run. Escape keeps it going. */
export function StopRunConfirm({ name, onStop, onKeep }: { name: string; onStop(): void; onKeep(): void }) {
  return (
    <span
      role="group"
      aria-label="Stop this run"
      data-esc-local
      className="inline-flex flex-wrap items-center gap-1.5"
      onKeyDown={(ev) => {
        if (ev.key === "Escape") (ev.stopPropagation(), onKeep());
      }}
    >
      <span className="text-ws-ink2">{stopRunQuestion(name)}</span>
      <Btn tone="dangerFill" autoFocus onClick={onStop}>
        Yes, stop
      </Btn>
      <Btn tone="ghost" onClick={onKeep}>
        Keep going
      </Btn>
    </span>
  );
}

/** What a card asks before Deny tells the agent no: unlike Allow once, nothing else follows it. */
export const DENY_QUESTION = "Deny this?";

/** The card's confirm step for Deny, as `StopRunConfirm` is for Stop. Escape keeps it waiting. */
export function DenyConfirm({ onDeny, onKeep }: { onDeny(): void; onKeep(): void }) {
  return (
    <span
      role="group"
      aria-label="Deny this request"
      data-deny-confirm
      data-esc-local
      className="inline-flex flex-wrap items-center gap-1.5"
      onKeyDown={(ev) => {
        if (ev.key === "Escape") (ev.stopPropagation(), onKeep());
      }}
    >
      <span className="text-ws-ink2">{DENY_QUESTION}</span>
      <Btn tone="dangerFill" autoFocus onClick={onDeny}>
        Yes, deny
      </Btn>
      <Btn tone="ghost" onClick={onKeep}>
        Keep waiting
      </Btn>
    </span>
  );
}

/** Moves focus to the first decision button when it is on the sheet itself, as it is on opening; a click elsewhere is not stolen. */
export function focusDecision(root: Pick<Element, "closest" | "querySelector"> | null, active: Element | null) {
  const sheet = root?.closest("#agent-sheet");
  if (sheet && active === sheet) root?.querySelector<HTMLButtonElement>("[data-permission-decisions] button:not(:disabled)")?.focus({ preventScroll: true });
}

/**
 * A run asking permission, on its sheet and its cards: what it wants to run, exactly, and what the person can do about it
 * (`permissionOffer`). Allow once only where it is offered, which is never on a read-only run; Deny always; Stop clearly as
 * abandoning the run, and only after a confirm step (`confirmStop` on a card, the sheet's own on the sheet). Only the person answers: nothing here runs on its own.
 */
export function PermissionAsk({ run, onAttach, onStop, label, answered: given, confirmStop = false }: { run: Run; onAttach(): void; onStop(): void; label?: string; answered?: PermissionAnswered | null; confirmStop?: boolean }) {
  // A card asks here before Stop; the sheet passes its own confirm step as `onStop`.
  const [stopping, setStopping] = useState(false);
  const [denying, setDenying] = useState(false);
  const runs = useRuns((s) => s.runs);
  const busy = useRuns((s) => s.answering.has(run.id));
  const name = useMemo(() => label ?? labelsByRun(runs).get(run.id) ?? "Claude", [label, runs, run.id]);
  const offer = permissionOffer(run);
  const command = readAs(run.needs);
  // A Deny confirm belongs to the request it was opened for: a new request on the same run starts unasked.
  useEffect(() => setDenying(false), [command]);
  const kept = usePermissionConfirmation(run);
  // The sheet hands its own in, as it does every other state it shows; a card reads the store.
  const answered = given === undefined ? kept : given;
  const store = useRuns.getState();
  const deny = () => void store.denyPermission(run.id, command);
  const allow = () => void store.allowPermissionOnce(run.id, command);
  const ask = offer.ask;
  const what = !ask ? `${name} is asking permission:` : ask.tool === "Bash" ? `${name} wants to run this command:` : `${name} wants to use ${ask.tool} on:`;
  const allowed = answered?.kind === "allowed";
  const explained = !usePrefs((s) => s.permissionExplainerSeen) && !allowed;
  const note = useId();
  const root = useRef<HTMLDivElement>(null);
  // Opened from Needs you, the sheet has focus on itself; the decision is what the person came for, so the keyboard starts there.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusDecision(root.current, document.activeElement));
    return () => cancelAnimationFrame(frame);
  }, [run.id]);
  return (
    <div ref={root} data-permission-ask data-allow={offer.allow} className="grid gap-2">
      <p className="m-0 font-semibold text-ws-ink">{what}</p>
      {command ? <CodeBox text={ask ? ask.command : command} what="the command" wrap /> : <p className="m-0 text-ws-ink2">It didn&apos;t say what.</p>}
      {explained && <PermissionExplainer allow={offer.allow === "offered"} />}
      {allowed ? (
        <PermissionSent answered={answered} />
      ) : offer.allow === "offered" ? (
        !explained && <p className="m-0 text-sm text-ws-ink2">{ALLOW_ONCE_NOTE}</p>
      ) : (
        <p data-permission-refusal className="m-0 text-sm font-semibold text-ws-ink">
          {offer.reason}
        </p>
      )}
      {/* The refusal says Claude Code won't; what Deny then does is said next to it, not under the buttons. */}
      {offer.allow === "readOnly" && !allowed && (
        <p data-permission-read-only className="m-0 text-sm text-ws-ink2">
          {READ_ONLY_STEP_NOTE}
        </p>
      )}
      {/* The card behind takes a click or Enter as opening the run; these buttons are answers of their own. */}
      <div data-permission-decisions className="flex flex-wrap items-center gap-2" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
        {offer.allow === "offered" && !allowed && (
          <Btn tone="primary" icon="term" disabled={busy || !run.shortId} onClick={allow}>
            Allow once in Terminal
          </Btn>
        )}
        {denying ? (
          <DenyConfirm onDeny={() => (setDenying(false), deny())} onKeep={() => setDenying(false)} />
        ) : (
          <Btn tone={offer.allow === "readOnly" || offer.allow === "forbidden" ? "primary" : "plain"} icon="x" disabled={busy || !command} aria-describedby={explained ? undefined : note} onClick={() => setDenying(true)}>
            Deny
          </Btn>
        )}
        {(offer.allow === "notExact" || offer.allow === "unchecked" || allowed) && (
          <Btn tone={allowed ? "plain" : "primary"} icon="term" disabled={!run.shortId} title={run.shortId ? undefined : "There is no session to open yet"} onClick={onAttach}>
            Open in Terminal
          </Btn>
        )}
        {stopping ? (
          <StopRunConfirm name={name} onStop={() => (setStopping(false), onStop())} onKeep={() => setStopping(false)} />
        ) : (
          <Btn tone="danger" icon="stop" disabled={busy} onClick={confirmStop ? () => setStopping(true) : onStop}>
            {STOP_LABEL}
          </Btn>
        )}
      </div>
      {/* The explainer says it already, above. */}
      {!explained && (
        <p id={note} className="m-0 text-xs text-ws-ink3">
          Deny: {DENY_NOTE}
        </p>
      )}
    </div>
  );
}
