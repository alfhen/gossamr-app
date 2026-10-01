import { useEffect, useMemo, useRef, useState } from "react";
import { MentionTextarea } from "../components/MentionTextarea";
import { docText } from "../lib/docs";
import { autoLink, liveMentions, type Mention } from "../lib/mentions";
import { targetOf, unreachable } from "../lib/proposals";
import { useBackend } from "../backend/useBackend";
import type { Person, Proposal, ProposalEdit } from "../types";
import { draftStatus } from "./boardLogic";
import { showMe } from "./jump";
import { KIND_LABEL } from "./agentsLogic";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { useWorkspace, workflowOfItem } from "../workspaceStore";
import { itemKey } from "../lib/filter";

const BADGE: Record<Proposal["state"]["type"], string> = {
  pending: "Needs your approval",
  applying: "Working…",
  applied: "Done",
  skipped: "Skipped",
  retired: "Out of date",
};

const LINK_VERB: Record<Extract<Proposal["intent"], { type: "link" }>["kind"], string> = { blocks: "blocks", relates: "relates to", duplicates: "duplicates", implementedBy: "is implemented by" };

/** What a link draft says, such as `CA-2 blocks CA-1`. */
export const linkSentence = (i: Extract<Proposal["intent"], { type: "link" }>) => `${i.from.key} ${LINK_VERB[i.kind]} ${i.to.key}`;

export function draftTitle(p: Proposal): string {
  const i = p.intent;
  switch (i.type) {
    case "comment":
      return `Comment on ${i.item.key}`;
    case "transition":
      return `Move ${i.item.key}`;
    case "subtasks":
      return `Subtasks under ${i.parent.key}`;
    case "create":
      return `New ${i.fields.kind}`;
    case "update":
      return `Update ${i.item.key}`;
    case "link":
      return `Link ${i.from.key}`;
    case "startRun":
      return `Start an agent: ${i.item?.key ?? i.spec.repo}`;
    default:
      return unreachable(i);
  }
}

/** One line for lists: what approving would do. */
export function draftSummary(p: Proposal, statusName: string | null): string {
  const i = p.intent;
  switch (i.type) {
    case "comment":
      return docText(i.body).replace(/\s+/g, " ");
    case "transition":
      return `to ${statusName ?? p.label ?? i.to}`;
    case "subtasks":
      return `${i.summaries.length} subtask${i.summaries.length === 1 ? "" : "s"}: ${i.summaries.join(", ")}`;
    case "create":
      return i.fields.title;
    case "update":
      return "Change fields";
    case "link":
      return linkSentence(i);
    case "startRun":
      return `${i.spec.kind} in ${i.spec.repo}`;
    default:
      return unreachable(i);
  }
}

export interface DraftCardProps {
  proposal: Proposal;
  /** The status a transition moves to, by name. */
  statusName: string | null;
  people: Person[];
  working: boolean;
  error: string | null;
  onApprove(edit: ProposalEdit | null): void;
  onSkip(): void;
  /** Opens the setup sheet for a run draft, the one place it is approved. */
  onReview?(): void;
  /** Present when the draft's item may be off screen. */
  onShow?(): void;
  /** Opens the agent run a draft was made from. */
  onOpenRun?(runId: string): void;
}

const button = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45";

export function DraftCard({ proposal: p, statusName, people, working, error, onApprove, onSkip, onReview, onShow, onOpenRun }: DraftCardProps) {
  const intent = p.intent;
  const key = targetOf(intent)?.key ?? "";
  const stored = intent.type === "comment" ? docText(intent.body) : "";
  const linked = useMemo(() => autoLink(stored, people), [stored, people]);
  const [body, setBody] = useState(linked.text);
  const [mentions, setMentions] = useState<Mention[]>(linked.mentions);
  const [editing, setEditing] = useState(false);
  const edited = useRef(false);
  const summaries = intent.type === "subtasks" ? intent.summaries : [];
  const made = p.created.length;
  const [picked, setPicked] = useState<boolean[]>(summaries.map(() => true));
  useEffect(() => setPicked(summaries.map(() => true)), [summaries.join("\n")]);
  // People can arrive after the card first renders; link them unless the text was edited by hand.
  useEffect(() => {
    if (edited.current) return;
    setBody(linked.text);
    setMentions(linked.mentions);
  }, [linked]);

  const state = p.state.type;
  const open = state === "pending" || state === "applying";
  const remaining = summaries.filter((_, i) => i >= made && picked[i]).length;
  const revision = p.revisions[p.revisions.length - 1];
  const shownError = error ?? p.error;

  const edit = (): ProposalEdit | null => {
    if (intent.type === "comment" && edited.current) return { type: "comment", body, mentions: liveMentions(body, mentions) };
    if (intent.type === "subtasks") {
      const wanted = summaries.filter((_, i) => i < made || picked[i]);
      return wanted.length === summaries.length ? null : { type: "subtasks", summaries: wanted };
    }
    return null;
  };

  const runDraft = intent.type === "startRun";
  const action =
    intent.type === "comment"
      ? "Post comment"
      : intent.type === "transition"
        ? (p.label ?? `Move to ${statusName ?? ""}`.trim())
        : intent.type === "create"
          ? `Create ${intent.fields.kind}`
          : intent.type === "subtasks"
            ? `Create ${remaining} subtask${remaining === 1 ? "" : "s"}`
            : intent.type === "link"
              ? "Create link"
              : "Apply";

  return (
    <article
      aria-label={draftTitle(p)}
      data-draft={p.id}
      className={`ws-legacy overflow-hidden rounded-[10px] border border-dashed border-ws-pip bg-ws-win text-base ${state === "skipped" || state === "retired" ? "opacity-55" : ""}`}
    >
      <div className="flex items-center gap-2 bg-ws-pip-soft px-3 py-1.5 text-sm font-semibold text-ws-pip">
        <span aria-hidden>✦</span>
        {draftTitle(p)}
        <span className="ml-auto font-normal text-ws-ink3">{BADGE[state]}</span>
      </div>
      <div className="grid gap-2 px-3 py-2.5">
        {intent.type === "comment" &&
          (editing && open ? (
            <MentionTextarea
              id={`draft-${p.id}`}
              value={body}
              mentions={mentions}
              onChange={(v, m) => {
                edited.current = true;
                setBody(v);
                setMentions(m);
              }}
              ticketKey={key}
              people={people}
              className="rounded-md border border-ws-sep2 bg-ws-win"
            />
          ) : (
            <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</p>
          ))}
        {intent.type === "transition" && (
          <p className="m-0">
            Move <b className="font-mono">{key}</b> to <b>{statusName ?? p.label ?? intent.to}</b>
          </p>
        )}
        {intent.type === "create" && (
          <div className="grid gap-1">
            <b>{intent.fields.title}</b>
            {docText(intent.fields.body) && <div className="whitespace-pre-wrap text-ws-ink2">{docText(intent.fields.body)}</div>}
          </div>
        )}
        {intent.type === "link" && (
          <p className="m-0">
            <b className="font-mono">{intent.from.key}</b> {LINK_VERB[intent.kind]} <b className="font-mono">{intent.to.key}</b>
          </p>
        )}
        {intent.type === "subtasks" &&
          summaries.map((s, i) => (
            <label key={i} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={picked[i] || i < made}
                disabled={!open || i < made}
                onChange={(e) => setPicked(picked.map((v, j) => (j === i ? e.target.checked : v)))}
                className="mt-1"
              />
              {s}
              {i < made && <span className="ml-auto font-mono text-ws-ink3">{p.created[i].key}</span>}
            </label>
          ))}
        {intent.type === "startRun" && (
          <div className="grid gap-1.5">
            <p className="m-0 flex items-baseline gap-2 font-semibold">
              {KIND_LABEL[intent.spec.kind]} {intent.item?.key ?? intent.spec.repo}
              {p.createdBy === "pip" && <span className="rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">Proposed by Pip</span>}
            </p>
            <p className="m-0 line-clamp-3 whitespace-pre-wrap text-ws-ink2 [overflow-wrap:anywhere]">{intent.spec.instruction}</p>
            {intent.spec.focus?.trim() && (
              <p className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2 py-1 text-sm [overflow-wrap:anywhere]">
                <b className="font-semibold text-ws-pip">Focus from Pip{intent.spec.focusFromRun ? `, after reading run ${intent.spec.focusFromRun}` : ""}:</b> {intent.spec.focus.trim()}
              </p>
            )}
            <p className="m-0 text-sm text-ws-ink3">Runs as you, with your Claude settings, in a new worktree of {intent.spec.clonePath}. Read the exact prompt and checks, then start it. Nothing runs before that.</p>
          </div>
        )}
        {p.origin.type === "run" && (
          <p data-provenance="run" className="m-0 text-sm text-ws-ink3">
            From agent run{" "}
            {onOpenRun ? (
              <button type="button" onClick={() => onOpenRun((p.origin as { runId: string }).runId)} className="font-mono font-semibold text-ws-pip hover:underline">
                {p.origin.shortId ?? "(no session id)"}
              </button>
            ) : (
              <b className="font-mono">{p.origin.shortId ?? "(no session id)"}</b>
            )}
            . The words are the agent&apos;s. Read and edit them before you approve.
          </p>
        )}
        {p.state.type === "retired" && <p className="m-0 text-sm text-ws-ink3">{p.state.reason}</p>}
        {open && revision && !shownError && <p className="m-0 text-sm text-ws-ink3">{revision.note}</p>}
        {shownError && (
          <p role="alert" className="m-0 text-sm text-ws-blocked">
            {shownError}
          </p>
        )}
        {(open || onShow) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onShow && (
              <button type="button" onClick={onShow} className="mr-auto text-sm text-ws-pip hover:underline">
                Show me
              </button>
            )}
            {open && (
              <>
                {intent.type === "comment" && (
                  <button type="button" disabled={working} onClick={() => setEditing(!editing)} className={button}>
                    {editing ? "Done editing" : "Edit"}
                  </button>
                )}
                <button type="button" disabled={working} onClick={onSkip} className={button}>
                  Skip
                </button>
                {runDraft && onReview && (
                  <button type="button" disabled={working} onClick={onReview} className="rounded-md bg-ws-pip px-2.5 py-1 text-sm font-semibold text-ws-on-pip disabled:opacity-45">
                    Review and start
                  </button>
                )}
                {!runDraft && (
                  <button
                    type="button"
                    disabled={working || state === "applying" || (intent.type === "comment" && !body.trim()) || (intent.type === "subtasks" && remaining === 0)}
                    onClick={() => onApprove(edit())}
                    className="rounded-md bg-ws-pip px-2.5 py-1 text-sm font-semibold text-ws-on-pip disabled:opacity-45"
                  >
                    {working || state === "applying" ? "Working…" : action}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** A draft card wired to the workspace: approving or skipping goes through the store, and edits are saved first. */
export function LiveDraftCard({ proposal: p, jump = true }: { proposal: Proposal; jump?: boolean }) {
  const backend = useBackend();
  const names = useWorkspace((s) => s.names);
  const containers = useWorkspace((s) => s.containers);
  const target = targetOf(p.intent);
  const item = useWorkspace((s) => (target ? s.items[itemKey(target)] : undefined));
  const people = useMemo(() => Object.entries(names).map(([accountId, name]) => ({ accountId, name })), [names]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusName = item && p.intent.type === "transition" ? (draftStatus(p, workflowOfItem({ containers }, item))?.name ?? null) : null;

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

  return (
    <DraftCard
      proposal={p}
      statusName={statusName}
      people={people}
      working={working}
      error={error}
      onShow={jump && target && item ? () => showMe(target) : undefined}
      onSkip={() => void run(() => useWorkspace.getState().skip(p.id))}
      onOpenRun={(id) => useRuns.getState().openRun(id)}
      onReview={p.intent.type === "startRun" ? () => void useRunSetup.getState().begin({ proposalId: p.id }) : undefined}
      onApprove={(edit) =>
        void run(async () => {
          if (edit && backend) await backend.proposalsEdit(p.id, edit);
          return useWorkspace.getState().approve(p.id);
        })
      }
    />
  );
}
