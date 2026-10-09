import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoHeight } from "../components/autoHeight";
import { useBackend } from "../backend/useBackend";
import { MentionTextarea } from "../components/MentionTextarea";
import { containerKey } from "../lib/filter";
import { leftByRun } from "../lib/proposals";
import type { Person, Proposal, WorkContainer, WorkItemKind } from "../types";
import { allContainers, useWorkspace } from "../workspaceStore";
import { createdItemKey, draftAfter, draftItem, draftKey, editFor, fieldsOf, ITEM_KINDS, placeOf, waitingCreates, type DraftFields, type DraftPlace } from "./draftTicket";
import { askPip } from "./askPip";
import { openTicketByKey } from "./jump";
import { finishWithPipPrompt } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { usePrefs } from "./prefs";
import { PeekView, type DraftSlots, type PeekViewProps } from "./PeekSheet";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const SAVE_DELAY_MS = 700;
const HANDOVER_MS = 6000;

const field = "rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink disabled:opacity-60";
const secondary = "rounded-lg border border-ws-sep2 bg-ws-win px-3.5 py-2 text-base hover:bg-ws-hover disabled:opacity-45";
const KBD = "rounded border border-current/40 px-1 font-sans text-xs font-medium opacity-85";

let stepped: "prev" | "next" | null = null;

type Create = Proposal & { intent: Extract<Proposal["intent"], { type: "create" }> };

export interface DraftPeekViewProps extends Pick<PeekViewProps, "motion" | "wide" | "width" | "onWide" | "onMotionEnd" | "onClose"> {
  proposal: Create;
  fields: DraftFields;
  containers: WorkContainer[];
  people: Person[];
  working: boolean;
  error: string | null;
  onChange(patch: Partial<DraftFields>): void;
  onCommit(): void;
  onCreate(): void;
  onSkip(): void;
  /** Where this draft stands among those waiting; the sheet offers stepping between them when there is more than one. */
  place?: DraftPlace | null;
  onStep?(id: string, how: "prev" | "next"): void;
  /** Present for a draft made from an agent run: opens that run. */
  onOpenRun?(): void;
  /** Present for a pending draft a run left: opens Pip on the run and this draft. */
  onFinishWithPip?(): void;
}

const CHIP_SELECT = `${field} py-0.5 font-semibold`;

function TitleField({ value, disabled, onChange, onBlur }: { value: string; disabled: boolean; onChange(value: string): void; onBlur(): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(ref, value);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label="Title"
      value={value}
      disabled={disabled}
      placeholder="Title"
      onChange={(e) => onChange(e.target.value.replace(/\s*\n\s*/g, " "))}
      onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && e.preventDefault()}
      onBlur={onBlur}
      className={`${field} block w-full resize-none overflow-hidden text-[20px] leading-tight font-semibold`}
    />
  );
}

const STEP = "rounded-md px-2 py-0.5 font-semibold text-ws-ink2 hover:bg-ws-hover disabled:opacity-40 disabled:hover:bg-transparent";

function DraftNav({ place, onStep }: { place: DraftPlace; onStep(id: string, how: "prev" | "next"): void }) {
  return (
    <div role="group" aria-label={`Drafts waiting, ${place.position} of ${place.total}`} className="ml-auto flex shrink-0 items-center gap-0.5 text-sm">
      <button type="button" data-step="prev" aria-label="Previous draft" disabled={!place.prev} onClick={() => place.prev && onStep(place.prev, "prev")} className={STEP}>
        <span aria-hidden>‹ </span>Prev
      </button>
      <span className="px-1 font-semibold text-ws-ink tabular-nums">
        {place.position} of {place.total}
      </span>
      <button type="button" data-step="next" aria-label="Next draft" disabled={!place.next} onClick={() => place.next && onStep(place.next, "next")} className={STEP}>
        Next<span aria-hidden> ›</span>
      </button>
    </div>
  );
}

export function DraftPeekView({ proposal: p, fields, containers, people, working, error, onChange, onCommit, onCreate, onSkip, place, onStep, onOpenRun, onFinishWithPip, ...view }: DraftPeekViewProps) {
  const { state } = p;
  const open = state.type === "pending";
  const created = state.type === "applied" ? (p.created[0]?.key ?? null) : null;
  const shownError = error ?? p.error;
  const revision = p.revisions[p.revisions.length - 1];
  const inProject = containers.filter((c) => c.ref.connectionId === fields.container.connectionId);
  const parent = p.intent.fields.parent;
  const priority = p.intent.fields.priority;

  const slots: DraftSlots = {
    banner: (
      <div className="grid gap-1">
        <div role="note" className="flex items-center gap-2 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-1.5 text-sm font-semibold text-ws-pip">
          <span aria-hidden>✦</span>
          <span>New ticket draft</span>
          {p.origin.type === "run" && (
            <span className="font-normal">
              · From agent run{" "}
              {onOpenRun ? (
                <button type="button" onClick={onOpenRun} title="Open the run this draft came from" className="rounded px-1 font-semibold underline decoration-dotted hover:bg-ws-hover">
                  {p.origin.shortId ?? "open it"}
                </button>
              ) : (
                p.origin.shortId
              )}
            </span>
          )}
          <span className="font-normal">· not created yet</span>
          <span className="ml-auto font-normal text-ws-ink3">{state.type === "applied" ? "Created" : state.type === "applying" ? "Creating…" : "Needs your approval"}</span>
        </div>
      </div>
    ),
    title: (
      <TitleField value={fields.title} disabled={!open} onChange={(title) => onChange({ title })} onBlur={onCommit} />
    ),
    meta: (
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-ws-ink2">
        <label className="flex items-center gap-1.5">
          Project
          <select
            aria-label="Project"
            value={containerKey(fields.container)}
            disabled={!open || inProject.length < 2}
            onChange={(e) => {
              const next = inProject.find((c) => containerKey(c.ref) === e.target.value);
              if (next) onChange({ container: next.ref });
            }}
            onBlur={onCommit}
            className={CHIP_SELECT}
          >
            {!inProject.some((c) => containerKey(c.ref) === containerKey(fields.container)) && <option value={containerKey(fields.container)}>{fields.container.externalId}</option>}
            {inProject.map((c) => (
              <option key={containerKey(c.ref)} value={containerKey(c.ref)}>
                {c.key} · {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Type
          <select aria-label="Type" value={fields.kind} disabled={!open} onChange={(e) => onChange({ kind: e.target.value as WorkItemKind })} onBlur={onCommit} className={`${CHIP_SELECT} capitalize`}>
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {parent && (
          <span>
            Parent <b className="font-mono font-semibold text-ws-ink">{parent.key}</b>
          </span>
        )}
        {priority && (
          <span>
            Priority <b className="font-semibold text-ws-ink capitalize">{priority}</b>
          </span>
        )}
      </div>
    ),
    description: open ? (
      <MentionTextarea
        id={`draft-body-${p.id}`}
        value={fields.body}
        mentions={fields.mentions}
        onChange={(body, mentions) => onChange({ body, mentions })}
        onBlur={onCommit}
        ticketKey=""
        people={people}
        placeholder="Describe the ticket"
        fill
        className="grow rounded-md border border-ws-sep2 bg-ws-win"
      />
    ) : (
      <p className="m-0 whitespace-pre-wrap text-ws-ink2">{fields.body || "No description."}</p>
    ),
    nav: place && place.total > 1 && onStep ? <DraftNav place={place} onStep={onStep} /> : undefined,
    actions: (
      <>
        <div className="grid min-w-0 flex-1 basis-56 gap-0.5 text-sm">
          {shownError ? (
            <p role="alert" className="m-0 font-semibold text-ws-blocked [overflow-wrap:anywhere]">
              {shownError}
            </p>
          ) : created ? (
            <p role="status" className="m-0 font-semibold text-ws-ink">
              Created {created}. Opening it…
            </p>
          ) : (
            <>
              {open && revision && <p className="m-0 font-semibold text-ws-pip">↻ {revision.note}</p>}
              <p id={`draft-reassure-${p.id}`} className="m-0 text-ws-ink2">
                <b className="font-semibold text-ws-ink">Nothing is created until you choose Create {fields.kind}.</b>
                {open && place && place.total > 1 ? " Either way, the next draft opens." : ""}
              </p>
            </>
          )}
        </div>
        {open || state.type === "applying" ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {open && onFinishWithPip && (
              <button type="button" disabled={working} onClick={onFinishWithPip} title="Pip reads the whole run and this draft, and tightens it if you ask" className={secondary}>
                Finish with Pip
              </button>
            )}
            <button type="button" disabled={working} onClick={onSkip} className={secondary}>
              Skip
            </button>
            <button
              type="button"
              disabled={working || state.type === "applying" || !fields.title.trim()}
              onClick={onCreate}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              aria-describedby={`draft-reassure-${p.id}`}
              className="inline-flex items-center gap-2 rounded-lg bg-ws-pip px-4 py-2 text-base font-semibold text-ws-on-pip shadow-sm hover:brightness-110 disabled:opacity-45"
            >
              {working || state.type === "applying" ? (
                "Working…"
              ) : (
                <>
                  Create {fields.kind}
                  <kbd aria-hidden className={KBD}>
                    ⌘↵
                  </kbd>
                </>
              )}
            </button>
          </div>
        ) : null}
      </>
    ),
  };

  const item = useMemo(() => draftItem(p), [p]);
  return (
    <PeekView
      item={item}
      draft={slots}
      assignee=""
      now={new Date(p.updatedAt)}
      moves={[]}
      menuOpen={false}
      links={[]}
      comments={[]}
      history={[]}
      description={null}
      drafts={null}
      composer={null}
      notice={null}
      onMenu={() => {}}
      onMove={() => {}}
      onLink={() => {}}
      onOpen={() => {}}
      {...view}
    />
  );
}

const openRunOf = (p: Proposal) => p.origin.type === "run" && useRuns.getState().openRun(p.origin.runId);

function finishWithPip(p: Proposal) {
  if (p.origin.type !== "run") return;
  askPip(finishWithPipPrompt({ id: p.origin.runId }, p.id));
}

type Motion = Pick<DraftPeekViewProps, "motion" | "wide" | "width" | "onWide" | "onMotionEnd">;

/** The draft ticket of a pending `create` proposal in the peek sheet. Edits are saved to the proposal as they are made; nothing is written to the tracker until Create task. */
export function LiveDraftPeek({ proposalId, ...motion }: { proposalId: string } & Motion) {
  const p = useWorkspace((s) => s.proposals[proposalId]);
  return p?.intent.type === "create" ? <OpenDraft proposal={p as Create} {...motion} /> : null;
}

function OpenDraft({ proposal: p, ...motion }: { proposal: Create } & Motion) {
  const backend = useBackend();
  const names = useWorkspace((s) => s.names);
  const containers = useWorkspace((s) => s.containers);
  const people = useMemo(() => Object.entries(names).map(([accountId, name]) => ({ accountId, name })), [names]);
  const [fields, setFields] = useState(() => fieldsOf(p));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ p, fields });
  latest.current = { p, fields };
  const seen = useRef(fieldsOf(p));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());

  // Something else changed the draft (Pip revised it): take the new values for the fields that haven't been touched here.
  useEffect(() => {
    const now = fieldsOf(p);
    const was = seen.current;
    seen.current = now;
    setFields((f) => ({
      title: f.title === was.title ? now.title : f.title,
      body: f.body === was.body ? now.body : f.body,
      mentions: f.body === was.body ? now.mentions : f.mentions,
      kind: f.kind === was.kind ? now.kind : f.kind,
      container: containerKey(f.container) === containerKey(was.container) ? now.container : f.container,
    }));
  }, [p]);

  const save = useCallback(() => {
    clearTimeout(timer.current);
    saving.current = saving.current.then(async () => {
      const { p: current, fields: next } = latest.current;
      const edit = backend && current.state.type === "pending" ? editFor(current, next) : null;
      if (!edit) return;
      try {
        await backend!.proposalsEdit(current.id, edit);
        setError(null);
        await useWorkspace.getState().refreshProposals();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return saving.current;
  }, [backend]);

  useEffect(() => {
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => clearTimeout(timer.current);
  }, [fields, save]);
  useEffect(() => () => void save(), [save]);

  const proposals = useWorkspace((s) => s.proposals);
  const waiting = useMemo(() => waitingCreates(proposals), [proposals]);
  const place = placeOf(waiting, p.id);
  const step = (id: string, how: "prev" | "next") => {
    stepped = how;
    useTabs.getState().select(draftKey(id));
  };

  const run = async (job: () => Promise<Proposal | null>) => {
    setWorking(true);
    setError(null);
    try {
      const done = await job();
      if (done?.error) setError(done.error);
      return done && !done.error ? done : null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setWorking(false);
    }
  };

  // Once this draft is decided, the next one waiting opens in its place.
  const decided = async (job: () => Promise<Proposal | null>) => {
    const next = draftAfter(waiting, p.id);
    const done = await run(job);
    if (!done || !next) return;
    const made = done.created[0];
    if (made) useToasts.getState().push(`Created ${made.key}.`, "info", { label: "Open", run: () => void openTicketByKey(made.key) });
    useTabs.getState().select(draftKey(next));
  };

  useEffect(() => {
    const how = stepped;
    stepped = null;
    const sheet = document.getElementById("peek-sheet");
    const button = how && (sheet?.querySelector<HTMLElement>(`[data-step=${how}]:not(:disabled)`) ?? sheet?.querySelector<HTMLElement>("[data-step]:not(:disabled)"));
    (button || sheet)?.focus({ preventScroll: true });
  }, []);

  const create = () =>
    void decided(async () => {
      await save();
      return useWorkspace.getState().approve(p.id);
    });
  const createNow = useRef(create);
  createNow.current = create;
  const ready = p.state.type === "pending" && !working && !!fields.title.trim();
  const readyNow = useRef(ready);
  readyNow.current = ready;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented && ev.key === "Escape") return;
      if (usePrefs.getState().paletteOpen || document.getElementById("agent-sheet")) return;
      const focus = document.activeElement;
      const typing = focus instanceof HTMLElement && (focus.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName));
      const inside = !!focus?.closest("#peek-sheet");
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !ev.altKey) {
        if (typing && !inside) return;
        ev.preventDefault();
        if (readyNow.current) createNow.current();
        return;
      }
      if (ev.key !== "Escape") return;
      if (typing) {
        if (inside) (focus as HTMLElement).blur();
        return;
      }
      useTabs.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const createdKey = p.state.type === "applied" ? createdItemKey(p) : null;
  const arrived = useWorkspace((s) => (createdKey ? !!s.items[createdKey] : false));
  const applied = p.state.type === "applied";
  useEffect(() => {
    if (!applied) return;
    const here = () => useTabs.getState().selected === draftKey(p.id);
    if (createdKey && arrived) {
      if (here()) useTabs.getState().select(createdKey);
      return;
    }
    const timeout = setTimeout(() => {
      if (!here()) return;
      useTabs.getState().select(null);
      const made = p.created[0];
      useToasts.getState().push(made ? `Created ${made.key}.` : "Created.", "info", made ? { label: "Open", run: () => void openTicketByKey(made.key) } : undefined);
    }, HANDOVER_MS);
    return () => clearTimeout(timeout);
  }, [applied, createdKey, arrived, p.id]);

  return (
    <DraftPeekView
      proposal={p}
      fields={fields}
      containers={allContainers({ containers })}
      people={people}
      working={working}
      error={error}
      onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
      onCommit={() => void save()}
      place={place}
      onStep={step}
      onSkip={() => void decided(() => useWorkspace.getState().skip(p.id))}
      onCreate={create}
      onClose={() => useTabs.getState().select(null)}
      onOpenRun={p.origin.type === "run" ? () => openRunOf(p) : undefined}
      onFinishWithPip={leftByRun(p) ? () => finishWithPip(p) : undefined}
      {...motion}
    />
  );
}
