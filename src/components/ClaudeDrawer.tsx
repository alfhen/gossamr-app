import { useEffect, useMemo, useRef, useState } from "react";
import { claude, type ClaudeSessions } from "../backend/claude";
import { useClaude, type Turn } from "../claudeStore";
import { docText } from "../lib/docs";
import { autoLink, liveMentions, participants, type Mention } from "../lib/mentions";
import { draftsForTurn, earlierDrafts, targetOf } from "../lib/proposals";
import { relativeTime } from "../lib/views";
import { selectedTicket, useStore } from "../store";
import type { Proposal, Status, Ticket } from "../types";
import { Sparkle } from "./icons";
import { Markdown } from "./Markdown";
import { MentionTextarea } from "./MentionTextarea";
import { StatusPill } from "./primitives";

const HOME = "~";

function suggestions(t: Ticket): string[] {
  return [
    t.children.length ? "How is this epic doing?" : "What changed and what do I need to do?",
    "Draft a reply to the latest comment",
    "Break this into subtasks",
    "Is this done in the code?",
    "Move it forward",
  ];
}

function folderName(cwd: string) {
  return cwd.replace(/^\/Users\/[^/]+/, HOME);
}

interface SessionOption {
  value: string;
  label: string;
  sessionId: string | null;
  cwd: string | null;
}

function sessionOptions(s: ClaudeSessions | null, now: Date): SessionOption[] {
  const opts: SessionOption[] = [];
  if (s?.last) {
    opts.push({ value: `resume:${s.last.id}`, label: "Continue this ticket's session", sessionId: s.last.id, cwd: s.last.cwd });
  }
  for (const r of s?.recent ?? []) {
    if (r.id === s?.last?.id) continue;
    opts.push({
      value: `resume:${r.id}`,
      label: `Continue “${r.title}” · ${folderName(r.cwd).split("/").pop()} · ${relativeTime(r.updated, now)}`,
      sessionId: r.id,
      cwd: r.cwd,
    });
  }
  const folders = [...new Set((s?.recent ?? []).map((r) => r.cwd))].slice(0, 5);
  for (const cwd of folders) opts.push({ value: `new:${cwd}`, label: `New session in ${folderName(cwd)}`, sessionId: null, cwd });
  opts.push({ value: "new:", label: "New session in your home folder", sessionId: null, cwd: null });
  return opts;
}

export function ClaudeDrawer() {
  const store = useStore();
  const ticket = selectedTicket(store);
  const { open, setOpen, byTicket, proposals, ask, cancel } = useClaude();
  const conv = ticket ? byTicket[ticket.key] : undefined;
  const [sessions, setSessions] = useState<ClaudeSessions | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => sessionOptions(sessions, store.now), [sessions, store.now]);
  const running = conv?.turns.some((t) => t.status === "running") ?? false;
  const earlier = useMemo(
    () => (ticket ? earlierDrafts(proposals, ticket.key, conv?.turns.map((t) => t.requestId) ?? []) : []),
    [proposals, ticket?.key, conv],
  );

  useEffect(() => {
    if (!open || !ticket) return;
    let live = true;
    claude
      .sessions(ticket.key)
      .then((s) => {
        if (!live) return;
        setSessions(s);
        // Default to this ticket's own session, else a fresh one in the folder you used most recently.
        const firstFolder = sessionOptions(s, new Date()).find((o) => o.value.startsWith("new:") && o.cwd);
        setChoice(s.last ? `resume:${s.last.id}` : (firstFolder?.value ?? "new:"));
      })
      .catch(() => live && setSessions({ last: null, recent: [] }));
    inputRef.current?.focus();
    return () => {
      live = false;
    };
  }, [open, ticket?.key]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [conv, proposals]);

  if (!open || !ticket) return null;

  const submit = (prompt: string) => {
    const text = prompt.trim();
    if (!text || running) return;
    // Follow-ups continue the session this conversation already started.
    const opt = options.find((o) => o.value === choice);
    const sessionId = conv?.sessionId ?? opt?.sessionId ?? null;
    const cwd = conv?.cwd ?? opt?.cwd ?? null;
    setInput("");
    void ask(ticket.key, text, sessionId, cwd);
  };

  return (
    <aside
      aria-label={`Ask Pip about ${ticket.key}`}
      className="absolute inset-y-0 right-0 z-40 flex w-[min(440px,100%)] flex-col border-l border-sep-strong bg-win shadow-[-12px_0_40px_rgb(0_0_0/0.12)]"
    >
      <header className="grid gap-2 border-b border-sep bg-bar px-3.5 pt-3 pb-3">
        <div className="flex items-center gap-2 font-semibold">
          <span className="grid size-[22px] place-items-center rounded-md bg-claude text-white">
            <Sparkle className="size-3" />
          </span>
          Ask Pip about {ticket.key}
          <span className="text-xs font-normal text-ink-3">powered by Claude</span>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="ml-auto rounded px-1.5 text-lg leading-none text-ink-3 hover:bg-hover">
            ×
          </button>
        </div>
        {conv?.sessionId ? (
          <div className="text-sm text-ink-2">
            Continuing session <span className="font-mono">{conv.sessionId.slice(0, 8)}</span>
            {conv.cwd && <> in {folderName(conv.cwd)}</>}
          </div>
        ) : (
          <label className="flex items-center gap-1.5 text-sm text-ink-2">
            Session
            <select
              id="claude-session"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-field-border bg-field px-1.5 py-1 text-sm text-ink"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div ref={bodyRef} className="selectable grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3.5 overflow-y-auto p-3.5">
        {!conv?.turns.length && (
          <>
            <p className="text-ink-2">
              Pip reads the ticket, its history and the repo in the chosen session's folder. Anything it wants to change in Jira shows up
              here as a card for you to approve.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions(ticket).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="rounded-full border border-sep-strong px-3 py-1 text-[12.5px] hover:border-claude hover:text-claude"
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {earlier.length > 0 && (
          <>
            <p className="text-sm font-semibold text-ink-2">Drafts waiting on {ticket.key}</p>
            {earlier.map((p) => (
              <ProposalView key={p.id} proposal={p} />
            ))}
          </>
        )}
        {conv?.turns.map((t) => <TurnView key={t.requestId} turn={t} proposals={proposals} />)}
      </div>

      <form
        className="grid gap-1.5 border-t border-sep px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="claude-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about this ticket, or tell Pip what to do…"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-field-border bg-field px-2.5 py-2 outline-none focus:border-claude focus:ring-3 focus:ring-claude-soft"
          />
          {running ? (
            <button type="button" onClick={() => cancel(ticket.key)} className="rounded-md border border-field-border px-3 font-semibold">
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="rounded-md bg-claude px-3 font-semibold text-white disabled:opacity-45">
              Ask
            </button>
          )}
        </div>
        <p className="text-xs text-ink-3">
          Runs your Claude Code with your login, CLAUDE.md and skills. It can read code and git history; nothing changes in Jira until you
          approve it.
        </p>
      </form>
    </aside>
  );
}

function TurnView({ turn, proposals }: { turn: Turn; proposals: Proposal[] }) {
  return (
    <>
      <div className="max-w-[85%] justify-self-end rounded-[14px_14px_4px_14px] bg-accent px-3 py-1.5 whitespace-pre-wrap text-white [overflow-wrap:anywhere]">
        {turn.prompt}
      </div>
      {(turn.steps.length > 0 || (turn.status === "running" && !turn.text)) && (
        <ul className="grid gap-1 text-sm text-ink-2">
          {turn.steps.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-done" />
              {s}
            </li>
          ))}
          {turn.status === "running" && !turn.text && <li className="animate-pulse text-ink-3">Working…</li>}
        </ul>
      )}
      {turn.text && <Markdown text={turn.text} />}
      {draftsForTurn(proposals, turn.requestId).map((p) => (
        <ProposalView key={p.id} proposal={p} />
      ))}
      {turn.status === "failed" && (
        <div role="alert" className="rounded-md bg-blocked-bg px-3 py-2 text-blocked">
          {turn.error ?? "Pip stopped"}
        </div>
      )}
    </>
  );
}

const CATEGORY = { todo: "new", active: "indeterminate", done: "done" } as const;

/** The status a transition draft moves to, from the cached workflow; the draft's label stands in until it loads. */
function useTargetStatus(p: Proposal): Status {
  const backend = useStore((s) => s.backend);
  const [found, setFound] = useState<Status | null>(null);
  const intent = p.intent;
  useEffect(() => {
    if (!backend || intent.type !== "transition") return;
    let live = true;
    void backend
      .cacheItem(intent.item)
      .then((item) => (item ? backend.cacheWorkflow(item.container) : null))
      .then((w) => {
        const def = w?.statuses.find((s) => s.id === intent.to);
        if (live && def) setFound({ name: def.name, category: CATEGORY[def.category] });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [backend, p.id]);
  return found ?? { name: p.label ?? (intent.type === "transition" ? intent.to : ""), category: "indeterminate" };
}

function ProposalView({ proposal: p }: { proposal: Proposal }) {
  const backend = useStore((s) => s.backend);
  const showToast = useStore((s) => s.showToast);
  const putProposal = useClaude((s) => s.putProposal);
  const intent = p.intent;
  const key = targetOf(intent)?.key ?? "";
  const ticket = useStore((s) => s.snap?.tickets[key]);
  const me = useStore((s) => s.snap?.me.accountId ?? "");
  const people = useMemo(() => (ticket ? participants(ticket, me) : []), [ticket, me]);
  const status = useTargetStatus(p);
  const stored = intent.type === "comment" ? docText(intent.body) : "";
  // Pip writes "@Sam"; link that to the person on the ticket so posting it actually notifies them.
  const [draft] = useState(() => autoLink(stored, people));
  const [body, setBody] = useState(draft.text);
  const [mentions, setMentions] = useState<Mention[]>(draft.mentions);
  const edited = useRef(false);
  // The ticket may not be cached yet on first render; link once its people arrive, unless the draft was edited.
  useEffect(() => {
    if (edited.current || intent.type !== "comment" || !people.length) return;
    const linked = autoLink(stored, people);
    setBody(linked.text);
    setMentions(linked.mentions);
  }, [people]);
  const summaries = intent.type === "subtasks" ? intent.summaries : [];
  const made = p.created.length;
  const [picked, setPicked] = useState<boolean[]>(summaries.map(() => true));
  useEffect(() => setPicked(summaries.map(() => true)), [summaries.join("\n")]);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const state = p.state.type;
  const open = state === "pending" || state === "applying";
  const remaining = summaries.filter((_, i) => i >= made && picked[i]).length;

  const save = async (): Promise<Proposal> => {
    if (!backend) throw new Error("no backend");
    if (intent.type === "comment") {
      return backend.proposalsEdit(p.id, { type: "comment", body, mentions: liveMentions(body, mentions) });
    }
    if (intent.type === "subtasks") {
      const wanted = summaries.filter((_, i) => i < made || picked[i]);
      return wanted.length === summaries.length ? p : backend.proposalsEdit(p.id, { type: "subtasks", summaries: wanted });
    }
    return p;
  };

  const saveQuietly = () => {
    if (!open || intent.type !== "comment" || body === stored || !body.trim()) return;
    void save().then(putProposal).catch(() => {});
  };

  const approve = async () => {
    if (!backend) return;
    setWorking(true);
    setProblem(null);
    try {
      await save();
      const done = await backend.proposalsApprove(p.id);
      putProposal(done);
      if (done.state.type === "applied") {
        showToast(
          intent.type === "comment"
            ? `Commented on ${key}`
            : intent.type === "transition"
              ? `${key}: ${p.label ?? status.name}`
              : `Created ${done.created.map((c) => c.key).join(", ")}`,
        );
      }
    } catch (e) {
      setProblem(String(e));
    } finally {
      setWorking(false);
    }
  };

  const skip = () => {
    if (!backend) return;
    backend.proposalsSkip(p.id).then(putProposal, (e) => setProblem(String(e)));
  };

  const title =
    intent.type === "comment"
      ? `Comment on ${key}`
      : intent.type === "transition"
        ? `Transition ${key}`
        : intent.type === "subtasks"
          ? `Subtasks under ${key}`
          : intent.type === "create"
            ? `New ${intent.fields.kind}`
            : "Draft";
  const action =
    intent.type === "comment"
      ? "Post comment"
      : intent.type === "transition"
        ? (p.label ?? `Move to ${status.name}`)
        : intent.type === "create"
          ? `Create ${intent.fields.kind}`
          : `Create ${remaining} subtasks`;
  const revision = p.revisions[p.revisions.length - 1];
  const error = problem ?? p.error;
  const badge = { applied: "Done", skipped: "Skipped", retired: "Out of date", pending: "Needs your approval", applying: "Working…" }[state];

  return (
    <div className={`overflow-hidden rounded-[10px] border border-sep-strong ${state === "skipped" || state === "retired" ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-2 bg-claude-soft px-3 py-2 text-sm font-semibold text-claude">
        {title}
        <span className="ml-auto font-normal text-ink-3">{badge}</span>
      </div>
      <div className="grid gap-2 px-3 py-2.5">
        {intent.type === "comment" && (
          <MentionTextarea
            id={`proposal-${p.id}`}
            value={body}
            mentions={mentions}
            onChange={(v, m) => {
              edited.current = true;
              setBody(v);
              setMentions(m);
            }}
            onBlur={saveQuietly}
            ticketKey={key}
            people={people}
            disabled={!open}
            className="rounded-md border border-field-border bg-field"
          />
        )}
        {intent.type === "transition" && (
          <div className="flex items-center gap-2">
            Move <b className="font-mono">{key}</b> to <StatusPill status={status} />
          </div>
        )}
        {intent.type === "create" && (
          <div className="grid gap-1">
            <b>{intent.fields.title}</b>
            {docText(intent.fields.body) && <div className="whitespace-pre-wrap text-ink-2">{docText(intent.fields.body)}</div>}
          </div>
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
              {i < made && <span className="ml-auto font-mono text-ink-3">{p.created[i].key}</span>}
            </label>
          ))}
        {state === "retired" && p.state.type === "retired" && <div className="text-sm text-ink-3">{p.state.reason}</div>}
        {open && revision && !error && <div className="text-sm text-ink-3">{revision.note}</div>}
        {error && <div className="text-sm text-blocked">{error}</div>}
        {open && (
          <div className="flex justify-end gap-2">
            <button type="button" disabled={working} onClick={skip} className="rounded-md border border-field-border px-3 py-1 disabled:opacity-45">
              Skip
            </button>
            <button
              type="button"
              disabled={working || state === "applying" || (intent.type === "comment" && !body.trim()) || (intent.type === "subtasks" && remaining === 0)}
              onClick={() => void approve()}
              className="rounded-md bg-accent px-3 py-1 font-semibold text-white disabled:opacity-45"
            >
              {working || state === "applying" ? "Working…" : action}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
