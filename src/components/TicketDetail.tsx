import { useEffect, useMemo, useRef, useState } from "react";
import { liveMentions, participants, segments, type Mention } from "../lib/mentions";
import { snoozeOptions, relativeTime } from "../lib/views";
import { selectedEvent, selectedTicket, useStore } from "../store";
import type { Snapshot, Ticket, Transition, Uploaded } from "../types";
import { filesIn, formatSize, nameFor } from "../lib/attachments";
import { useClaude } from "../claudeStore";
import { Adf } from "./Adf";
import { Icon, Sparkle } from "./icons";
import { Menu } from "./Menu";
import { MentionTextarea } from "./MentionTextarea";
import { Avatar, SectionHeading, StatusPill, ToolbarButton } from "./primitives";

export function TicketDetail() {
  const state = useStore();
  const { overlay, openOverlay, backend, markDone, snooze, transition, now } = state;
  const ticket = selectedTicket(state);
  const event = selectedEvent(state);
  const transitionBtn = useRef<HTMLDivElement>(null);
  const snoozeBtn = useRef<HTMLDivElement>(null);
  const [transitions, setTransitions] = useState<Transition[] | null>(null);

  useEffect(() => {
    if (overlay !== "transition" || !ticket || !backend) return;
    let live = true;
    setTransitions(null);
    backend
      .transitions(ticket.key)
      .then((t) => live && setTransitions(t))
      .catch(() => live && setTransitions([]));
    return () => {
      live = false;
    };
  }, [overlay, ticket?.key, ticket?.status.name, backend]);

  if (!ticket) {
    return (
      <section className="grid place-items-center bg-win text-ink-3">
        <div className="text-center">
          <b className="mb-1 block text-[14px] text-ink-2">Nothing selected</b>Pick an item on the left.
        </div>
      </section>
    );
  }

  const close = () => openOverlay(null);

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-win">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-1.5 overflow-x-auto border-b border-sep bg-bar px-3">
        <div ref={transitionBtn}>
          <ToolbarButton title="Transition (t)" onClick={() => openOverlay("transition")}>
            Transition <kbd>t</kbd>
          </ToolbarButton>
        </div>
        <ToolbarButton title="Comment (c)" onClick={() => document.getElementById("composer")?.focus()}>
          Comment <kbd>c</kbd>
        </ToolbarButton>
        {event && (
          <>
            <div ref={snoozeBtn}>
              <ToolbarButton title="Snooze (s)" onClick={() => openOverlay("snooze")}>
                Snooze <kbd>s</kbd>
              </ToolbarButton>
            </div>
            <ToolbarButton title="Done (e)" onClick={() => void markDone()}>
              {event.doneAt ? "Not done" : "Done"} <kbd>e</kbd>
            </ToolbarButton>
          </>
        )}
        <span data-tauri-drag-region className="flex-1 self-stretch" />
        <ToolbarButton title="Open in Jira (o)" onClick={() => void backend?.openUrl(ticket.url)}>
          Open in Jira <Icon name="external" className="size-3" />
        </ToolbarButton>
        <ToolbarButton
          variant="claude"
          disabled={backend?.kind !== "jira"}
          title={backend?.kind === "jira" ? "Ask Claude (⌘J)" : "Sign in to Jira to ask Claude"}
          onClick={() => useClaude.getState().setOpen(!useClaude.getState().open)}
        >
          <Sparkle /> Ask Claude <kbd>⌘J</kbd>
        </ToolbarButton>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <TicketBody key={ticket.key} ticket={ticket} />
      </div>

      {overlay === "transition" && (
        <Menu
          title={`Move ${ticket.key} from ${ticket.status.name}`}
          anchor={transitionBtn.current}
          loading={transitions === null}
          onClose={close}
          items={(transitions ?? []).map((tr) => ({
            key: tr.id,
            label: tr.name,
            hint: <StatusPill status={tr.to} />,
            onPick: () => void transition(tr.id, tr.name),
          }))}
        />
      )}
      {overlay === "snooze" && event && (
        <Menu
          title="Snooze until"
          anchor={snoozeBtn.current}
          onClose={close}
          items={snoozeOptions(now).map((o) => ({
            key: o.label,
            label: o.label,
            hint: o.hint,
            onPick: () => void snooze(o.until),
          }))}
        />
      )}
    </section>
  );
}

function TicketBody({ ticket: t }: { ticket: Ticket }) {
  const { now, snap, openOverlay, goToTicket } = useStore();
  const me = snap?.me.accountId;
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const newComments = t.comments.filter((c) => c.created > since && c.author.accountId !== me);
  const knownPeople = useMemo(() => (snap ? everyone(snap) : []), [snap]);

  return (
    <div className="selectable grid max-w-[760px] gap-5 px-7 pt-5 pb-7">
      <div>
        <div className="flex flex-wrap gap-1.5 text-sm text-ink-3">
          {t.parent && (
            <button type="button" className="hover:underline" onClick={() => goToTicket(t.parent!.key)}>
              <span className="font-mono">{t.parent.key}</span> {t.parent.summary} /
            </button>
          )}
          <span className="font-mono">{t.key}</span> · {t.type}
        </div>
        <h1 className="mt-1 text-xl leading-tight font-bold tracking-tight text-balance">{t.summary}</h1>
      </div>

      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[12.5px] text-ink-2">
        <StatusPill status={t.status} onClick={() => openOverlay("transition")} />
        <Fact label="Assignee">
          <Avatar person={t.assignee} /> {t.assignee?.name ?? "Unassigned"}
        </Fact>
        {t.reporter && <Fact label="Reporter">{t.reporter.name}</Fact>}
        {t.priority && <Fact label="Priority">{t.priority}</Fact>}
        {t.dueDate ? (
          <Fact label="Due">{new Date(t.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</Fact>
        ) : (
          t.sprint && <Fact label="Sprint">{t.sprint}</Fact>
        )}
      </div>

      {(t.changes.length > 0 || newComments.length > 0) && (
        <div className="grid gap-2 rounded-[10px] border border-sep-strong bg-accent-soft px-3.5 py-3">
          <h3 className="text-xs font-semibold tracking-wide text-accent uppercase">Since you last looked</h3>
          {t.changes.map((c, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-2">
              <span className="min-w-[74px] font-semibold">{c.field}</span>
              <s className="text-ink-3">{c.from ?? "None"}</s> → <b>{c.to ?? "None"}</b>
              <span className="ml-auto text-sm text-ink-3">
                {c.author.name.split(" ")[0]} · {relativeTime(c.at, now)}
              </span>
            </div>
          ))}
          {newComments.map((c) => (
            <div key={c.id} className="flex flex-wrap items-baseline gap-2">
              <span className="min-w-[74px] font-semibold">Comment</span>
              <span>from {c.author.name.split(" ")[0]}</span>
              <span className="ml-auto text-sm text-ink-3">{relativeTime(c.created, now)}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <SectionHeading>Description</SectionHeading>
        {t.descriptionDoc ? (
          <Adf doc={t.descriptionDoc} />
        ) : (
          <div className="max-w-[65ch] whitespace-pre-wrap">{t.description || <span className="text-ink-3">No description.</span>}</div>
        )}
      </div>

      {t.children.length > 0 && snap && (
        <div>
          <SectionHeading>Issues in this epic</SectionHeading>
          {t.children
            .map((k) => snap.tickets[k])
            .filter(Boolean)
            .map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => goToTicket(c.key)}
                className="grid w-full grid-cols-[62px_1fr_auto_22px] items-center gap-2.5 border-b border-sep py-[7px] text-left hover:[&>.t]:underline"
              >
                <span className="font-mono text-[11.5px] font-semibold text-ink-2">{c.key}</span>
                <span className="t truncate">{c.summary}</span>
                <StatusPill status={c.status} />
                <Avatar person={c.assignee} />
              </button>
            ))}
        </div>
      )}

      {t.subtasks.length > 0 && (
        <div>
          <SectionHeading>
            Subtasks · {t.subtasks.filter((s) => s.done).length}/{t.subtasks.length}
          </SectionHeading>
          {t.subtasks.map((s) => (
            <div key={s.key} className="flex items-center gap-2 border-b border-sep py-[5px]">
              <span className={`grid size-3.5 place-items-center rounded border-[1.5px] ${s.done ? "border-done bg-done text-white" : "border-sep-strong"}`}>
                {s.done && <Icon name="check" className="size-3 [&_circle]:hidden" />}
              </span>
              <span className="w-[62px] font-mono text-[11.5px] font-semibold text-ink-2">{s.key}</span>
              {s.summary}
            </div>
          ))}
        </div>
      )}

      <div>
        <SectionHeading>Comments{t.comments.length ? ` · ${t.comments.length}` : ""}</SectionHeading>
        <div className="grid gap-3.5">
          {t.comments.length === 0 && <div className="text-ink-3">No comments yet.</div>}
          {t.comments.map((c) => (
            <div key={c.id} className="grid grid-cols-[28px_1fr] gap-2.5">
              <Avatar person={c.author} size={28} />
              <div>
                <div className="flex items-baseline gap-2">
                  <b className="font-semibold">{c.author.name}</b>
                  <span className="text-sm text-ink-3">{relativeTime(c.created, now)}</span>
                </div>
                {c.doc ? <Adf doc={c.doc} /> : <CommentBody body={c.body} people={[...(c.mentioned ?? []), ...knownPeople]} />}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Composer key={t.key} ticket={t} />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ink-3">{label}</span>
      {children}
    </span>
  );
}

interface PendingFile {
  id: string;
  file: File;
  preview: string | null;
  /** Set once uploaded, so a retry after a failed comment doesn't upload it again. */
  uploaded: Uploaded | null;
}

function Composer({ ticket }: { ticket: Ticket }) {
  const comment = useStore((s) => s.comment);
  const backend = useStore((s) => s.backend);
  const me = useStore((s) => s.snap?.me.accountId ?? "");
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const people = useMemo(() => participants(ticket, me), [ticket, me]);
  const fail = (message: string) => useStore.setState({ error: message });

  const previews = useRef(files);
  previews.current = files;
  useEffect(() => () => previews.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);

  const add = async (list: File[]) => {
    if (!backend || !list.length) return;
    const limit = await backend.attachmentLimit().catch(() => undefined);
    if (limit === null) return fail("Attachments are turned off on this Jira site");
    const tooBig = list.filter((f) => limit !== undefined && f.size > limit);
    if (tooBig.length && limit) fail(`${tooBig.map((f) => f.name || "The image").join(", ")} is over Jira's ${formatSize(limit)} limit`);
    const added = list
      .filter((f) => !tooBig.includes(f))
      .map((f) => {
        const file = nameFor(f);
        return { id: crypto.randomUUID(), file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null, uploaded: null };
      });
    setFiles((prev) => [...prev, ...added]);
  };

  const remove = (id: string) => {
    const f = files.find((x) => x.id === id);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    setFiles((prev) => prev.filter((x) => x.id !== id));
  };

  const send = async () => {
    if ((!body.trim() && !files.length) || sending || !backend) return;
    setSending(true);
    try {
      const uploaded: Uploaded[] = [];
      for (const f of files) {
        const u = f.uploaded ?? (await backend.attach(ticket.key, f.file));
        if (!f.uploaded) setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, uploaded: u } : x)));
        uploaded.push(u);
      }
      if (await comment(body, liveMentions(body, mentions), uploaded)) {
        files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
        setBody("");
        setMentions([]);
        setFiles([]);
      }
    } catch (e) {
      fail(`Couldn't upload to ${ticket.key}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        const dropped = filesIn(e.dataTransfer);
        setDragging(false);
        if (!dropped.length) return;
        e.preventDefault();
        void add(dropped);
      }}
      className={`rounded-[10px] border bg-field focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft ${dragging ? "border-accent ring-3 ring-accent-soft" : "border-field-border"}`}
    >
      <MentionTextarea
        id="composer"
        value={body}
        mentions={mentions}
        onChange={(v, m) => {
          setBody(v);
          setMentions(m);
        }}
        ticketKey={ticket.key}
        people={people}
        onSubmit={() => void send()}
        onPasteFiles={(f) => void add(f)}
        placeholder={`Comment on ${ticket.key}… (@ to mention, paste or drop files)`}
      />
      {files.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 pb-2.5">
          {files.map((f) => (
            <li key={f.id} title={`${f.file.name} · ${formatSize(f.file.size)}`} className="group relative">
              {f.preview ? (
                <img src={f.preview} alt={f.file.name} className="size-16 rounded-md border border-sep object-cover" />
              ) : (
                <span className="flex h-16 max-w-[180px] items-center gap-1.5 rounded-md border border-sep bg-hover px-2.5 text-sm">
                  <span aria-hidden>📎</span>
                  <span className="truncate">{f.file.name}</span>
                </span>
              )}
              {f.uploaded && <span className="absolute bottom-1 left-1 rounded bg-done px-1 text-[10px] font-semibold text-white">Uploaded</span>}
              <button
                type="button"
                aria-label={`Remove ${f.file.name}`}
                disabled={sending}
                onClick={() => remove(f.id)}
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-ink text-[11px] leading-none text-win opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:hidden"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 border-t border-sep py-1.5 pr-2 pl-3 text-[11.5px] text-ink-3">
        <span>
          <kbd>⌘</kbd> <kbd>↵</kbd> to send
        </span>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          aria-label="Attach files"
          title="Attach files"
          onClick={() => picker.current?.click()}
          className="ml-auto rounded px-1.5 py-0.5 text-[14px] hover:bg-hover hover:text-ink"
        >
          📎
        </button>
        <button
          type="button"
          disabled={(!body.trim() && !files.length) || sending}
          onClick={() => void send()}
          className="rounded-md bg-accent px-3 py-1 text-[12.5px] font-semibold text-white disabled:opacity-45"
        >
          {sending ? (files.some((f) => !f.uploaded) ? "Uploading…" : "Sending…") : "Comment"}
        </button>
      </div>
    </div>
  );
}

function everyone(snap: Snapshot): Mention[] {
  const people = new Map<string, Mention>([[snap.me.accountId, snap.me]]);
  for (const t of Object.values(snap.tickets)) {
    for (const p of [t.assignee, t.reporter, ...t.comments.map((c) => c.author)]) if (p) people.set(p.accountId, p);
  }
  return [...people.values()].map((p) => ({ accountId: p.accountId, name: p.name }));
}

/** A posted comment, with `@Name` for anyone we know highlighted. */
function CommentBody({ body, people }: { body: string; people: Mention[] }) {
  return (
    <div className="max-w-[65ch] whitespace-pre-wrap">
      {segments(body, people).map((part, i) =>
        part.mention ? (
          <span key={i} className="rounded-[4px] bg-accent-soft px-0.5 font-medium text-accent">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </div>
  );
}
