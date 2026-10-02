import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackend } from "../backend/useBackend";
import { MentionTextarea } from "../components/MentionTextarea";
import { containerKey } from "../lib/filter";
import type { Person, Proposal, WorkContainer, WorkItemKind } from "../types";
import { allContainers, useWorkspace } from "../workspaceStore";
import { createdItemKey, draftItem, draftKey, editFor, fieldsOf, ITEM_KINDS, type DraftFields } from "./draftTicket";
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
const button = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45";

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
  /** Present for a draft made from an agent run: opens that run. */
  onOpenRun?(): void;
  /** Present for a pending draft a run left: opens Pip on the run and this draft. */
  onFinishWithPip?(): void;
}

const CHIP_SELECT = `${field} py-0.5 font-semibold`;

export function DraftPeekView({ proposal: p, fields, containers, people, working, error, onChange, onCommit, onCreate, onSkip, onOpenRun, onFinishWithPip, ...view }: DraftPeekViewProps) {
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
        <p className="m-0 text-sm text-ws-ink3">{created ? `Created ${created}. Opening it…` : "Nothing is created until you choose Create task. Edit anything below first."}</p>
      </div>
    ),
    title: (
      <input
        aria-label="Title"
        value={fields.title}
        disabled={!open}
        placeholder="Title"
        onChange={(e) => onChange({ title: e.target.value })}
        onBlur={onCommit}
        className={`${field} w-full text-[20px] leading-tight font-semibold`}
      />
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
        className="rounded-md border border-ws-sep2 bg-ws-win"
      />
    ) : (
      <p className="m-0 whitespace-pre-wrap text-ws-ink2">{fields.body || "No description."}</p>
    ),
    actions: (
      <>
        {shownError ? (
          <p role="alert" className="m-0 mr-auto min-w-0 text-sm text-ws-blocked [overflow-wrap:anywhere]">
            {shownError}
          </p>
        ) : (
          open && revision && <p className="m-0 mr-auto min-w-0 truncate text-sm text-ws-pip">↻ {revision.note}</p>
        )}
        {open || state.type === "applying" ? (
          <>
            {open && onFinishWithPip && (
              <button type="button" disabled={working} onClick={onFinishWithPip} title="Pip reads the whole run and this draft, and tightens it if you ask" className={button}>
                Finish with Pip
              </button>
            )}
            <button type="button" disabled={working} onClick={onSkip} className={button}>
              Skip
            </button>
            <button type="button" disabled={working || state.type === "applying" || !fields.title.trim()} onClick={onCreate} className="rounded-md bg-ws-pip px-2.5 py-1 text-sm font-semibold text-ws-on-pip disabled:opacity-45">
              {working || state.type === "applying" ? "Working…" : `Create ${fields.kind}`}
            </button>
          </>
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

  const run = async (job: () => Promise<Proposal | null>) => {
    setWorking(true);
    setError(null);
    try {
      const done = await job();
      if (done?.error) setError(done.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented || usePrefs.getState().paletteOpen) return;
      const focus = document.activeElement;
      if (focus instanceof HTMLElement && (focus.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName))) return;
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
      onSkip={() => void run(() => useWorkspace.getState().skip(p.id))}
      onCreate={() =>
        void run(async () => {
          await save();
          return useWorkspace.getState().approve(p.id);
        })
      }
      onClose={() => useTabs.getState().select(null)}
      onOpenRun={p.origin.type === "run" ? () => openRunOf(p) : undefined}
      onFinishWithPip={p.origin.type === "run" && p.createdBy === "user" ? () => finishWithPip(p) : undefined}
      {...motion}
    />
  );
}
