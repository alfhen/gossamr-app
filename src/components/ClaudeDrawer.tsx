import { useEffect, useMemo, useRef, useState } from "react";
import { claude, type ClaudeSessions } from "../backend/claude";
import { useClaude, type ProposalCard, type Turn } from "../claudeStore";
import { autoLink, liveMentions, participants, type Mention } from "../lib/mentions";
import { relativeTime } from "../lib/views";
import { selectedTicket, useStore } from "../store";
import type { Ticket } from "../types";
import { Sparkle } from "./icons";
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
  const { open, setOpen, byTicket, ask, cancel } = useClaude();
  const conv = ticket ? byTicket[ticket.key] : undefined;
  const [sessions, setSessions] = useState<ClaudeSessions | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const options = useMemo(() => sessionOptions(sessions, store.now), [sessions, store.now]);
  const running = conv?.turns.some((t) => t.status === "running") ?? false;

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
  }, [conv]);

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
      aria-label={`Ask Claude about ${ticket.key}`}
      className="absolute inset-y-0 right-0 z-40 flex w-[min(440px,100%)] flex-col border-l border-sep-strong bg-win shadow-[-12px_0_40px_rgb(0_0_0/0.12)]"
    >
      <header className="grid gap-2 border-b border-sep bg-bar px-3.5 pt-3 pb-3">
        <div className="flex items-center gap-2 font-semibold">
          <span className="grid size-[22px] place-items-center rounded-md bg-claude text-white">
            <Sparkle className="size-3" />
          </span>
          Ask Claude about {ticket.key}
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

      <div ref={bodyRef} className="selectable grid min-h-0 flex-1 content-start gap-3.5 overflow-auto p-3.5">
        {!conv?.turns.length && (
          <>
            <p className="text-ink-2">
              Claude reads the ticket, its history and the repo in the chosen session's folder. Anything it wants to change in Jira shows up
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
        {conv?.turns.map((t) => <TurnView key={t.requestId} ticketKey={ticket.key} turn={t} />)}
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
            placeholder="Ask about this ticket, or tell Claude what to do…"
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

function TurnView({ ticketKey, turn }: { ticketKey: string; turn: Turn }) {
  return (
    <>
      <div className="max-w-[85%] justify-self-end rounded-[14px_14px_4px_14px] bg-accent px-3 py-1.5 text-white">{turn.prompt}</div>
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
      {turn.proposals.map((p) => (
        <ProposalView key={p.proposal.id} ticketKey={ticketKey} requestId={turn.requestId} card={p} />
      ))}
      {turn.status === "failed" && (
        <div role="alert" className="rounded-md bg-blocked-bg px-3 py-2 text-blocked">
          {turn.error ?? "Claude stopped"}
        </div>
      )}
    </>
  );
}

function ProposalView({ ticketKey, requestId, card }: { ticketKey: string; requestId: string; card: ProposalCard }) {
  const backend = useStore((s) => s.backend);
  const showToast = useStore((s) => s.showToast);
  const setProposal = useClaude((s) => s.setProposal);
  const p = card.proposal;
  const ticket = useStore((s) => s.snap?.tickets[p.key]);
  const me = useStore((s) => s.snap?.me.accountId ?? "");
  const people = useMemo(() => (ticket ? participants(ticket, me) : []), [ticket, me]);
  // Claude writes "@Sam"; link that to the person on the ticket so posting it actually notifies them.
  const [draft] = useState(() => autoLink(p.kind === "comment" ? p.body : "", people));
  const [body, setBody] = useState(draft.text);
  const [mentions, setMentions] = useState<Mention[]>(draft.mentions);
  const [picked, setPicked] = useState<boolean[]>(p.kind === "subtasks" ? p.summaries.map(() => true) : []);
  const patch = (x: Partial<ProposalCard>) => setProposal(ticketKey, requestId, p.id, x);

  const approve = async () => {
    if (!backend) return;
    patch({ state: "applying", error: null });
    try {
      if (p.kind === "comment") {
        await backend.comment(p.key, body, liveMentions(body, mentions));
        showToast(`Commented on ${p.key}`);
      } else if (p.kind === "transition") {
        await backend.transition(p.key, p.transition.id);
        showToast(`${p.key}: ${p.transition.name}`);
      } else {
        const todo = p.summaries.flatMap((_, i) => (picked[i] && !card.created?.[i] ? [i] : []));
        const out = await backend.createSubtasks(p.key, todo.map((i) => p.summaries[i]));
        const created = { ...card.created };
        out.created.forEach((k, j) => (created[todo[j]] = k));
        if (out.error) {
          const made = out.created.length ? `Created ${out.created.join(", ")}, then stopped: ` : "";
          return patch({ state: "pending", error: made + out.error, created });
        }
        patch({ created });
        showToast(`Created ${Object.values(created).join(", ")}`);
      }
      patch({ state: "applied" });
    } catch (e) {
      patch({ state: "pending", error: String(e) });
    }
  };

  const remaining = picked.filter((v, i) => v && !card.created?.[i]).length;
  const title = { comment: `Comment on ${p.key}`, transition: `Transition ${p.key}`, subtasks: `Subtasks under ${p.key}` }[p.kind];
  const action =
    p.kind === "comment" ? "Post comment" : p.kind === "transition" ? p.transition.name : `Create ${remaining} subtasks`;
  const done = card.state === "applied" || card.state === "skipped";

  return (
    <div className={`overflow-hidden rounded-[10px] border border-sep-strong ${card.state === "skipped" ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-2 bg-claude-soft px-3 py-2 text-sm font-semibold text-claude">
        {title}
        <span className="ml-auto font-normal text-ink-3">
          {card.state === "applied" ? "Done" : card.state === "skipped" ? "Skipped" : "Needs your approval"}
        </span>
      </div>
      <div className="grid gap-2 px-3 py-2.5">
        {p.kind === "comment" && (
          <MentionTextarea
            id={`proposal-${requestId}-${p.id}`}
            value={body}
            mentions={mentions}
            onChange={(v, m) => {
              setBody(v);
              setMentions(m);
            }}
            ticketKey={p.key}
            people={people}
            disabled={done}
            className="rounded-md border border-field-border bg-field"
          />
        )}
        {p.kind === "transition" && (
          <div className="flex items-center gap-2">
            Move <b className="font-mono">{p.key}</b> to <StatusPill status={p.transition.to} />
          </div>
        )}
        {p.kind === "subtasks" &&
          p.summaries.map((s, i) => (
            <label key={i} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={picked[i] || !!card.created?.[i]}
                disabled={done || !!card.created?.[i]}
                onChange={(e) => setPicked(picked.map((v, j) => (j === i ? e.target.checked : v)))}
                className="mt-1"
              />
              {s}
              {card.created?.[i] && <span className="ml-auto font-mono text-ink-3">{card.created[i]}</span>}
            </label>
          ))}
        {card.error && <div className="text-sm text-blocked">{card.error}</div>}
        {!done && (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => patch({ state: "skipped" })} className="rounded-md border border-field-border px-3 py-1">
              Skip
            </button>
            <button
              type="button"
              disabled={card.state === "applying" || (p.kind === "comment" && !body.trim()) || (p.kind === "subtasks" && remaining === 0)}
              onClick={() => void approve()}
              className="rounded-md bg-accent px-3 py-1 font-semibold text-white disabled:opacity-45"
            >
              {card.state === "applying" ? "Working…" : action}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Just enough Markdown for Claude's replies: paragraphs, bullet lists, **bold** and `code`. */
function Markdown({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <b key={i}>{part.slice(2, -2)}</b>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i} className="rounded bg-hover px-1 font-mono text-[12px]">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    );
  return (
    <div className="grid max-w-[65ch] gap-2">
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          return (
            <ul key={i} className="list-disc pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*] /, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(block)}
          </p>
        );
      })}
    </div>
  );
}
