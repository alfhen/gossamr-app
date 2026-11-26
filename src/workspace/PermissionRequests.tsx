import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { aimedAfresh, movedWithin, repeatOnOther, trackMoves } from "./buttonMoves";
import { inputLineCount } from "./permissionInput";
import { Button } from "../components/Button";
import { ButtonGroup } from "../components/ButtonGroup";
import { labelsByRun } from "../lib/workstreamStage";
import type { PermissionRequest, Run } from "../types";
import { CodeBox } from "./AgentSheet";
import { PERMISSIONS_WARNING, answeringKey, canAllow, denyOnlyWhy, openPermissions, permissionWants, runAnswerPending } from "./permissionLogic";
import { RequestInput } from "./RequestInput";
import { useRuns, type PermissionHover } from "./runsStore";

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
export function PermissionItem({ run, request, label, size, where, index = 0 }: { run: Run; request: PermissionRequest; label?: string; size?: Size; where?: PermissionHover["where"]; index?: number }) {
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
  const root = useRef<HTMLDivElement>(null);
  const seen = useSeenWhole(root);
  const [hint, setHint] = useState<string | null>(null);
  // An item answered from the keyboard leaves; the keyboard goes to the next request's heading, else the run's.
  useEffect(() => () => void (regain.current && setTimeout(regain.current, 0)), []);
  const onAnswer = (decision: "allow" | "deny", from: HTMLElement) => {
    const keyboard = document.activeElement === from;
    setHint(null);
    if (keyboard) regain.current = afterAnswer(from);
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
  // In a run's list, the item says when the pointer is on it, so its place is kept if it closes under the pointer.
  const note = () => where && root.current && useRuns.getState().hoverPermission({ where, runId: run.id, key, index, height: root.current.offsetHeight });
  const leave = () => {
    const hover = useRuns.getState().permissionHover;
    if (hover?.key === key && hover.where === where) useRuns.getState().hoverPermission(null);
  };
  return (
    <div ref={root} onPointerEnter={note} onPointerDown={note} onPointerLeave={leave}>
      <PermissionItemView name={name} request={request} answering={answering ?? null} held={held} unread={!seen} refused={refused} hint={hint} size={size} onAnswer={onAnswer} onMissed={(byKey) => setHint(byKey ? AIM_BY_KEY : AIM_BY_POINTER)} />
    </div>
  );
}

/** Why a click on Allow did nothing: it wasn't aimed at this request after the last answer. */
const AIM_BY_POINTER = "Not allowed yet: point at Allow again and click it.";
const AIM_BY_KEY = "Not allowed yet: move to Allow with Tab, then press it.";

/**
 * Where the keyboard goes once an item answered from it has left: the next request's heading, never its Allow; else the
 * run's own card or sheet heading, or the open Needs you decision's heading.
 */
function afterAnswer(from: HTMLElement): () => void {
  const list = from.closest<HTMLElement>("[data-permission-requests]");
  const card = from.closest<HTMLElement>("article[data-run-id]");
  const sheet = from.closest<HTMLElement>("#agent-sheet");
  return () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const next = list?.isConnected ? list.querySelector<HTMLElement>("[data-permission-heading]") : null;
    const heading = sheet?.isConnected ? sheet.querySelector<HTMLElement>("h2") : null;
    if (heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    const pane = document.querySelector<HTMLElement>("[data-needs-pane][data-open] [data-needs-pane-title]");
    const to = next ?? (card?.isConnected ? card : null) ?? heading ?? pane;
    to?.focus({ preventScroll: true });
  };
}

/**
 * Whether every part of the item's request (`[data-seen-part]`: its start, each stretch of its input, its end) has been on
 * screen since the item appeared. A request that fits on screen is seen at once; a long one only once scrolled through,
 * not by a jump to its end.
 */
function useSeenWhole(root: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const parts = Array.from(root.current?.querySelectorAll("[data-seen-part]") ?? []);
    if (!parts.length || typeof IntersectionObserver === "undefined") return setSeen(true);
    const left = new Set(parts);
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) left.delete(entry.target);
      if (left.size) return;
      watch.disconnect();
      setSeen(true);
    });
    parts.forEach((part) => watch.observe(part));
    return () => watch.disconnect();
  }, [root]);
  return seen;
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
function AnswerButton({ size, off, title, allow = false, onAnswer, onMissed, children }: { size: Size; off: boolean; title?: string; allow?: boolean; onAnswer(from: HTMLElement): void; onMissed?(byKey: boolean): void; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [moved, setMoved] = useState(0);
  // A move holds the button where you can see it, as a change to the list does.
  // Only Allow is followed: denying is safe wherever the button sits.
  useEffect(() => {
    const el = ref.current;
    if (!el || !allow) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = trackMoves(el, el.closest("[data-permission-answers]") ?? el, () => {
      setMoved((n) => n + 1);
      clearTimeout(timer);
      timer = setTimeout(() => setMoved(0), SETTLE_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [allow]);
  const held = off || moved > 0;
  return (
    <Button
      ref={ref}
      data-allow={allow || undefined}
      size={size}
      disabled={held}
      title={off ? title : moved > 0 ? "Wait a moment: the list just changed." : undefined}
      onClick={(ev) => {
        const el = ev.currentTarget;
        if (ev.detail > 1) return;
        if (allow && ev.detail === 1 && (movedWithin(el, SETTLE_MS) || repeatOnOther(el, REPEAT_MS))) return;
        // An Allow needs a fresh aim after any answer on the page, so clicks at one spot answer one request.
        if (allow && !aimedAfresh(el, ev.detail === 0)) return onMissed?.(ev.detail === 0);
        onAnswer(el);
      }}
    >
      {children}
    </Button>
  );
}

/** Why Allow waits for a request not yet seen whole. */
const UNREAD = "Scroll through the whole request to allow it.";

/** How long after a click a second one at the same spot, on what moved under it, is ignored. */
export const REPEAT_MS = 1000;

/** Lines from which an item also offers Deny at its top and says where Allow is. */
export const LONG_REQUEST_LINES = 40;

export function PermissionItemView({ name, request, answering, held = null, unread = false, refused = null, hint = null, size = "md", onAnswer, onMissed }: { name: string; request: PermissionRequest; answering: "allow" | "deny" | null; held?: string | null; unread?: boolean; refused?: string | null; hint?: string | null; size?: Size; onAnswer(decision: "allow" | "deny", from: HTMLElement): void; onMissed?(byKey: boolean): void }) {
  const why = denyOnlyWhy(request);
  const off = !!answering || !!held;
  const title = held ?? undefined;
  const length = request.input != null ? inputLineCount(request.kind, request.input) : 0;
  return (
    <div data-permission-request={request.id} className="grid gap-2">
      <p data-permission-heading tabIndex={-1} className="m-0 font-semibold text-ws-ink outline-none focus-visible:outline-2 focus-visible:outline-ws-pip">
        {name} wants to {permissionWants(request)}
      </p>
      {/* Denying unseen is safe, so a long request offers Deny before it too; Allow stays after all of it. */}
      {length > LONG_REQUEST_LINES && (
        <div data-permission-top className="flex flex-wrap items-center gap-2" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
          {/* Said whether or not it has been read, so nothing below moves once it has. */}
          <p className="m-0 text-sm text-ws-ink2">{`This request is ${length.toLocaleString("en")} lines long. Scroll through it to allow it: Allow is at its end.`}</p>
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
      {/* Every field of what an allow passes the agent, not only its heading, between marks that say when it was all on screen. */}
      <span data-seen-part aria-hidden className="block h-px" />
      {request.input != null ? <RequestInput kind={request.kind} input={request.input} /> : request.subject && <CodeBox text={request.subject} what="the request" wrap />}
      <span data-seen-part aria-hidden className="block h-px" />
      {request.kind === "permissions" && <p className="m-0 text-sm font-semibold text-ws-warn">{PERMISSIONS_WARNING}</p>}
      {why && <p className="m-0 text-sm text-ws-ink2">{why}</p>}
      {/* After the whole request, never beside it or sticky: Allow is reached only by passing all of it. The card behind
          takes a click or Enter as opening the run; these buttons are answers of their own. */}
      <div data-permission-answers onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
        <ButtonGroup label="Answer the permission request">
          {canAllow(request) && (
            <AnswerButton size={size} off={off || unread} title={title ?? (unread ? UNREAD : undefined)} allow onAnswer={(el) => onAnswer("allow", el)} onMissed={onMissed}>
              {answering === "allow" ? "Allowing…" : "Allow"}
            </AnswerButton>
          )}
          <AnswerButton size={size} off={off} title={title} onAnswer={(el) => onAnswer("deny", el)}>
            {answering === "deny" ? "Denying…" : "Deny"}
          </AnswerButton>
        </ButtonGroup>
      </div>
      {/* Below the buttons, so a line that comes and goes never moves them. */}
      {hint && (
        <p role="status" className="m-0 text-sm text-ws-ink2">
          {hint}
        </p>
      )}
      {refused && (
        <p role="status" className="m-0 text-sm text-ws-blocked">
          Not answered: {refused}
        </p>
      )}
    </div>
  );
}

/**
 * Every open request of a run, oldest first, each answered on its own; `except` is one Needs you shows. A request that
 * closes under the pointer, answered or withdrawn, leaves a line of its height in its place until the pointer leaves it, so
 * nothing below moves under a resting pointer.
 */
export function PermissionRequests({ run, label, size, except, where }: { run: Run; label?: string; size?: Size; except?: string; where: PermissionHover["where"] }) {
  const hover = useRuns((s) => (s.permissionHover?.runId === run.id && s.permissionHover.where === where ? s.permissionHover : null));
  const decided = useRuns((s) => (hover ? s.permissionDecided.get(hover.key) : undefined));
  const open = openPermissions(run).filter((request) => request.id !== except);
  const items = open.map((request, index) => <PermissionItem key={request.id} run={run} request={request} label={label} size={size} where={where} index={index} />);
  const closed = hover && !open.some((request) => answeringKey(run.id, request.id) === hover.key) ? hover : null;
  if (closed) {
    const text = decided === "allow" ? "You allowed this." : decided === "deny" ? "You denied this." : "This request closed.";
    items.splice(Math.min(closed.index, items.length), 0, <Closed key={`closed:${closed.key}`} height={closed.height} text={text} onGone={() => useRuns.getState().hoverPermission(null)} />);
  }
  return (
    <div data-permission-requests tabIndex={-1} className="grid gap-3 outline-none">
      {items}
    </div>
  );
}

/** Whether a run's list in `where` keeps a closed request's place under the pointer, so it stays drawn though none is open. */
export const useClosingIn = (run: Pick<Run, "id">, where: PermissionHover["where"]) => useRuns((s) => s.permissionHover?.runId === run.id && s.permissionHover.where === where);

/**
 * While the pointer is on one of a run's requests in its card, the card keeps at least the height it has, so an answer
 * there can't move the cards below it up under the pointer. Rendered inside the card; it draws nothing.
 */
export function HoldCardHeight({ run }: { run: Pick<Run, "id"> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const pointed = useClosingIn(run, "card");
  useLayoutEffect(() => {
    const card = ref.current?.closest<HTMLElement>("article");
    if (!card || !pointed) return;
    card.style.minHeight = `${card.getBoundingClientRect().height}px`;
    return () => void (card.style.minHeight = "");
  }, [pointed]);
  return <span ref={ref} hidden />;
}

/** The place a closed request keeps while the pointer is on it. It goes once the pointer is off it. */
function Closed({ height, text, onGone }: { height: number; text: string; onGone(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    const away = (ev: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r || ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) gone.current();
    };
    document.addEventListener("pointermove", away, true);
    return () => document.removeEventListener("pointermove", away, true);
  }, []);
  return (
    <div ref={ref} data-permission-closed role="status" style={{ height }} onPointerLeave={() => gone.current()} className="grid content-center rounded-md border border-dashed border-ws-sep px-2.5 text-sm text-ws-ink2">
      {text}
    </div>
  );
}
