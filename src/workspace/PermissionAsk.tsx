import { useEffect, useId, useMemo, useRef, useState } from "react";
import { permissionOffer, readAs } from "../lib/permission";
import { labelsByRun } from "../lib/workstreamStage";
import type { Run } from "../types";
import { Icon } from "./AgentIcons";
import { Btn, CodeBox } from "./AgentSheet";
import { permissionConfirmation, useRuns, type PermissionAnswered } from "./runsStore";

/** The one honest line beside Allow once: Gossamr can't say yes for the person, Claude Code's own prompt can. */
export const ALLOW_ONCE_NOTE = "Claude Code takes a yes only in its own prompt. Allow once opens this run in Terminal and copies the command: choose Yes there for this command only.";
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
  const runs = useRuns((s) => s.runs);
  const busy = useRuns((s) => s.answering.has(run.id));
  const name = useMemo(() => label ?? labelsByRun(runs).get(run.id) ?? "Claude", [label, runs, run.id]);
  const offer = permissionOffer(run);
  const command = readAs(run.needs);
  const kept = usePermissionConfirmation(run);
  // The sheet hands its own in, as it does every other state it shows; a card reads the store.
  const answered = given === undefined ? kept : given;
  const store = useRuns.getState();
  const deny = () => void store.denyPermission(run.id, command);
  const allow = () => void store.allowPermissionOnce(run.id, command);
  const ask = offer.ask;
  const what = !ask ? `${name} is asking permission:` : ask.tool === "Bash" ? `${name} wants to run this command:` : `${name} wants to use ${ask.tool} on:`;
  const allowed = answered?.kind === "allowed";
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
      {allowed ? (
        <PermissionSent answered={answered} />
      ) : offer.allow === "offered" ? (
        <p className="m-0 text-sm text-ws-ink2">{ALLOW_ONCE_NOTE}</p>
      ) : (
        <p data-permission-refusal className="m-0 text-sm font-semibold text-ws-ink">
          {offer.reason}
        </p>
      )}
      {/* The card behind takes a click or Enter as opening the run; these buttons are answers of their own. */}
      <div data-permission-decisions className="flex flex-wrap items-center gap-2" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
        {offer.allow === "offered" && !allowed && (
          <Btn tone="primary" icon="term" disabled={busy || !run.shortId} onClick={allow}>
            Allow once in Terminal
          </Btn>
        )}
        <Btn tone={offer.allow === "readOnly" || offer.allow === "forbidden" ? "primary" : "plain"} icon="x" disabled={busy || !command} aria-describedby={note} onClick={deny}>
          Deny
        </Btn>
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
      {offer.allow === "readOnly" && (
        <p data-permission-read-only className="m-0 text-xs text-ws-ink3">
          {READ_ONLY_STEP_NOTE}
        </p>
      )}
      <p id={note} className="m-0 text-xs text-ws-ink3">
        Deny: {DENY_NOTE}
      </p>
    </div>
  );
}
