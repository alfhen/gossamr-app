import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AdfNode, Comment, EventKind, InboxEvent, Person, Snapshot, Status, Ticket, Transition, Uploaded } from "../types";
import { fold, type Mention } from "../lib/mentions";
import type { Backend } from "./types";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const P = {
  me: { accountId: "me", name: "Alf Henderson" },
  sam: { accountId: "sam", name: "Sam Holt" },
  mette: { accountId: "mette", name: "Mette Lund" },
  jonas: { accountId: "jonas", name: "Jonas Berg" },
  priya: { accountId: "priya", name: "Priya Nair" },
} satisfies Record<string, Person>;

/** People who aren't on any sample ticket, so mention search has something to find. */
const EXTRA_PEOPLE: Person[] = [
  { accountId: "lars", name: "Lars Møller" },
  { accountId: "soren", name: "Søren Ødegård" },
  { accountId: "ida", name: "Ida Kjær" },
];

const S = {
  todo: { name: "To Do", category: "new" },
  prog: { name: "In Progress", category: "indeterminate" },
  review: { name: "In Review", category: "indeterminate" },
  blocked: { name: "Blocked", category: "indeterminate" },
  done: { name: "Done", category: "done" },
} satisfies Record<string, Status>;

const WORKFLOW: Record<string, [keyof typeof S, string][]> = {
  "To Do": [["prog", "Start progress"], ["blocked", "Block"]],
  "In Progress": [["review", "Send to review"], ["blocked", "Block"], ["todo", "Stop progress"]],
  "In Review": [["done", "Done"], ["prog", "Back to In Progress"]],
  Blocked: [["prog", "Unblock"], ["todo", "Back to To Do"]],
  Done: [["prog", "Reopen"]],
};

let seq = 1000;
const id = () => String(++seq);
const comment = (author: Person, minutesAgo: number, body: string): Comment => ({
  id: id(),
  author,
  created: ago(minutesAgo),
  body,
});

function ticket(t: Partial<Ticket> & Pick<Ticket, "key" | "summary" | "type" | "status">): Ticket {
  return {
    priority: "Medium",
    assignee: null,
    reporter: null,
    parent: null,
    description: "",
    comments: [],
    changes: [],
    subtasks: [],
    children: [],
    dueDate: null,
    sprint: null,
    url: `https://example.atlassian.net/browse/${t.key}`,
    updated: ago(60 * 24),
    ...t,
  };
}

function sampleSnapshot(): Snapshot {
  const epic = { key: "CA-400", summary: "Campaign translation pipeline" };
  const tickets: Ticket[] = [
    ticket({
      ...epic,
      type: "Epic",
      status: S.prog,
      priority: "High",
      assignee: P.mette,
      reporter: P.mette,
      dueDate: "2026-10-17",
      description:
        "Translate and roll out campaigns to every store automatically, with a human approval step before anything is sent.",
      children: ["CA-405", "CA-409", "CA-412", "CA-418", "CA-420", "CA-421"],
      comments: [comment(P.mette, 60 * 50, "@Alf can you confirm the 17 Oct go-live works for the CRM side?")],
      changes: [{ field: "Due date", from: "10 Oct", to: "17 Oct", author: P.mette, at: ago(180) }],
      updated: ago(180),
    }),
    ticket({
      key: "CA-412",
      summary: "Split translation rollout into parallel workers",
      type: "Story",
      status: S.prog,
      priority: "High",
      assignee: P.me,
      reporter: P.mette,
      parent: epic,
      sprint: "CRM 41",
      description:
        "Large campaigns take over an hour to roll out because translations run one language at a time. Run languages in parallel workers so a 12-language campaign finishes in under 15 minutes.",
      subtasks: [
        { key: "CA-413", summary: "Worker pool config in Horizon", done: true },
        { key: "CA-414", summary: "Fan-out job per language", done: true },
      ],
      comments: [
        comment(P.jonas, 60 * 48, "Horizon has room for 8 more workers on the queue box."),
        comment(P.me, 60 * 20, "Parallel workers are in. 12 languages now take 11 minutes on staging."),
        comment(P.mette, 22, "Can we cap concurrency per store? The DKK account is small and I don't want it hitting limits."),
      ],
      changes: [{ field: "Sprint", from: "CRM 40", to: "CRM 41", author: P.mette, at: ago(25) }],
      updated: ago(22),
    }),
    ticket({
      key: "CA-418",
      summary: "Retry translation batches when Klaviyo rate-limits us",
      type: "Story",
      status: S.blocked,
      priority: "High",
      assignee: P.sam,
      reporter: P.me,
      parent: epic,
      sprint: "CRM 41",
      description:
        "Overnight rollouts fail when Klaviyo returns 429. Batches should back off and retry instead of failing the whole campaign.\n\nDone when a 429 on one batch never fails the rollout, and retries show up in the rollout status.",
      comments: [comment(P.sam, 4, "@Alf do we know the per-account rate limit on the euro store? Batches keep failing around 02:00.")],
      changes: [{ field: "Status", from: "In Progress", to: "Blocked", author: P.sam, at: ago(5) }],
      updated: ago(4),
    }),
    ticket({
      key: "CA-420",
      summary: "Rollout status shows stale state after a retry",
      type: "Bug",
      status: S.review,
      priority: "High",
      assignee: P.jonas,
      reporter: P.me,
      parent: epic,
      sprint: "CRM 41",
      description: "After a batch is retried, the rollout status endpoint keeps reporting the failed state until the next full refresh.",
      descriptionDoc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "After a batch is retried, " },
              { type: "text", text: "GET /rollouts/:id/status", marks: [{ type: "code" }] },
              { type: "text", text: " keeps reporting the " },
              { type: "text", text: "failed", marks: [{ type: "strong" }] },
              { type: "text", text: " state until the next full refresh. The status is read from a cached row:" },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "php" },
            content: [{ type: "text", text: "$status = Rollout::query()\n    ->where('id', $id)\n    ->remember(300)\n    ->value('status');" }],
          },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Retry the batch from the dashboard" }] }] },
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Status stays failed for up to 5 minutes" }] }] },
            ],
          },
          {
            type: "panel",
            attrs: { panelType: "warning" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Customers see this as a failed send and retry again." }] }],
          },
        ],
      },
      comments: [
        comment(P.me, 60 * 70, "Repro: retry batch 7 on the euro store and the status stays failed for about 5 minutes."),
        comment(P.jonas, 60 * 20, "Pushed a fix: retries now re-read state before reporting. PR is up."),
        comment(P.sam, 38, "Looks good. One question on the retry backoff: is 30s enough for the euro store?"),
      ],
      changes: [{ field: "Status", from: "In Progress", to: "In Review", author: P.jonas, at: ago(60) }],
      updated: ago(60),
    }),
    ticket({
      key: "CA-405",
      summary: "Alert when a rollout stalls for more than an hour",
      type: "Story",
      status: S.prog,
      assignee: P.me,
      reporter: P.mette,
      parent: epic,
      sprint: "CRM 41",
      description: "Post to #crm-alerts when a rollout makes no progress for an hour.",
      updated: ago(60 * 24 * 5),
    }),
    ticket({
      key: "CE-690",
      summary: "Update cookie banner copy for the NO store",
      type: "Task",
      status: S.todo,
      priority: "Low",
      assignee: P.me,
      reporter: P.priya,
      sprint: "CE 16",
      description: "Legal sent new wording for the Norwegian cookie banner.",
      comments: [comment(P.priya, 60 * 24 * 12, "@Alf legal is asking when this can go out, any update?")],
      updated: ago(60 * 24 * 12),
    }),
    ticket({
      key: "CA-409",
      summary: "Per-store translation settings",
      type: "Story",
      status: S.done,
      assignee: P.me,
      reporter: P.mette,
      parent: epic,
      sprint: "CRM 41",
      description: "Let each store choose which languages it rolls out.",
      resolved: ago(60 * 72),
      updated: ago(60 * 72),
    }),
    ticket({
      key: "CA-421",
      summary: "Dashboard for translation throughput",
      type: "Story",
      status: S.todo,
      priority: "Low",
      reporter: P.mette,
      parent: epic,
      sprint: "Backlog",
      description: "Show languages per hour, failures and retries per store.",
      assignee: P.me,
      updated: ago(60 * 24 * 7 + 60),
    }),
    ticket({
      key: "CE-731",
      summary: "Match app block copy with the web version",
      type: "Story",
      status: S.todo,
      assignee: P.me,
      reporter: P.priya,
      sprint: "CE 18",
      description: "Several app blocks still use old copy. Align the text with the web blocks listed in the content sheet.",
      comments: [comment(P.priya, 110, "Copy sheet is in the description. The checkout blocks matter most.")],
      changes: [{ field: "Assignee", from: "Unassigned", to: "Alf Henderson", author: P.priya, at: ago(120) }],
      updated: ago(120),
    }),
    ticket({
      key: "CE-705",
      summary: "Broken footer links on the DE store",
      type: "Bug",
      status: S.done,
      priority: "Low",
      assignee: P.priya,
      reporter: P.me,
      sprint: "CE 17",
      description: "Three footer links on the DE store return 404.",
      changes: [{ field: "Status", from: "In Review", to: "Done", author: P.priya, at: ago(60 * 26) }],
      updated: ago(60 * 26),
    }),
  ];

  const ev = (kind: EventKind, ticketKey: string, actor: Person, minutesAgo: number, text: string, unread: boolean): InboxEvent => ({
    id: id(),
    kind,
    ticketKey,
    actor,
    at: ago(minutesAgo),
    text,
    unread,
    doneAt: null,
    snoozedUntil: null,
  });

  return {
    me: P.me,
    site: "example.atlassian.net",
    tickets: Object.fromEntries(tickets.map((t) => [t.key, t])),
    events: [
      ev("mention", "CA-418", P.sam, 4, "@Alf do we know the per-account rate limit on the euro store? Batches keep failing around 02:00.", true),
      ev("comment", "CA-412", P.mette, 22, "Can we cap concurrency per store? The DKK account is small and I don't want it hitting limits.", true),
      ev("status", "CA-420", P.jonas, 60, "In Progress → In Review", true),
      ev("assigned", "CE-731", P.priya, 120, "Assigned to you", true),
      ev("field", "CA-400", P.mette, 180, "Due date 10 Oct → 17 Oct", false),
      ev("status", "CE-705", P.priya, 60 * 26, "In Review → Done", false),
      ev("comment", "CA-420", P.jonas, 60 * 20, "Pushed a fix: retries now re-read state before reporting. PR is up.", false),
      ev("comment", "CA-420", P.sam, 38, "Looks good. One question on the retry backoff: is 30s enough for the euro store?", true),
      ev("field", "CA-420", P.jonas, 52, "Priority Medium → High", true),
      ev("comment", "CE-731", P.priya, 110, "Copy sheet is in the description. The checkout blocks matter most.", true),
      { ...ev("mention", "CE-690", P.priya, 60 * 24 * 12, "@Alf legal is asking when this can go out, any update?", false), doneAt: ago(60 * 24 * 11) },
      { ...ev("mention", "CA-400", P.mette, 60 * 50, "@Alf can you confirm the 17 Oct go-live works for the CRM side?", false), doneAt: ago(60 * 49) },
    ],
    watching: ["CA-418", "CA-420", "CE-705", "CA-400"],
    activity: [
      { ticketKey: "CA-412", at: ago(60 * 46), kind: "transition", text: "To Do → In Progress" },
      { ticketKey: "CA-409", at: ago(60 * 72), kind: "transition", text: "In Review → Done" },
      { ticketKey: "CA-421", at: ago(60 * 70 + 30), kind: "created", text: "" },
      { ticketKey: "CE-705", at: ago(60 * 96), kind: "transition", text: "In Progress → In Review" },
    ],
    lastSyncAt: new Date().toISOString(),
  };
}

const SIMULATED: [EventKind, string, keyof typeof P, string][] = [
  ["mention", "CE-731", "priya", "@Alf the design is final. The copy sheet is linked in the description, can you start this week?"],
  ["comment", "CA-420", "jonas", "Checks are green. Could you review when you have 10 minutes?"],
];

/** In-memory backend with sample data, used for `pnpm dev` in a browser and until a Jira site is connected. */
/** A rough stand-in for the document Jira builds for a comment with files, so sample mode renders them the same way. */
function withFiles(body: string, files: Uploaded[]): AdfNode {
  const paragraphs: AdfNode[] = body
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }));
  const media = files.map<AdfNode>((f) =>
    f.mimeType.startsWith("image/")
      ? { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: f.mediaId, alt: f.filename } }] }
      : { type: "paragraph", content: [{ type: "text", text: `📎 ${f.filename}` }] },
  );
  return { type: "doc", content: [...paragraphs, ...media] };
}

export class MockBackend implements Backend {
  readonly kind = "mock" as const;
  private snap = sampleSnapshot();
  private listeners = new Set<(s: Snapshot) => void>();
  private simulated = 0;

  async load() {
    return this.snap;
  }

  subscribe(listener: (s: Snapshot) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private update(fn: (s: Snapshot) => void) {
    const next = structuredClone(this.snap);
    fn(next);
    this.snap = next;
    this.listeners.forEach((l) => l(next));
  }

  private event(s: Snapshot, eventId: string) {
    const e = s.events.find((x) => x.id === eventId);
    if (!e) throw new Error(`Unknown event ${eventId}`);
    return e;
  }

  async transitions(key: string): Promise<Transition[]> {
    const t = this.snap.tickets[key];
    return (WORKFLOW[t.status.name] ?? []).map(([to, name]) => ({ id: `${key}:${to}`, name, to: S[to] }));
  }

  async transition(key: string, transitionId: string) {
    const to = S[transitionId.split(":")[1] as keyof typeof S];
    if (!to) throw new Error(`Unknown transition ${transitionId}`);
    this.update((s) => {
      s.tickets[key].status = to;
      s.tickets[key].updated = new Date().toISOString();
    });
  }

  async comment(key: string, body: string, mentions: Mention[] = [], files: Uploaded[] = []) {
    const doc = files.length ? withFiles(body, files) : undefined;
    this.update((s) => {
      s.tickets[key].comments.push({ id: id(), author: s.me, created: new Date().toISOString(), body, mentioned: mentions, doc });
    });
  }

  /** Files "uploaded" in sample mode, as object URLs by media id. */
  readonly files = new Map<string, string>();

  async attach(_key: string, file: File): Promise<Uploaded> {
    const mediaId = `sample-${id()}`;
    this.files.set(mediaId, URL.createObjectURL(file));
    return { id: id(), filename: file.name, mimeType: file.type, mediaId };
  }

  dispose() {
    this.files.forEach((url) => URL.revokeObjectURL(url));
    this.files.clear();
  }

  async attachmentLimit() {
    return 10 * 1024 * 1024;
  }

  async ticketMedia() {
    return Object.fromEntries([...this.files.keys()].map((k) => [k, k]));
  }

  attachmentUrl(id: string) {
    return this.files.get(id) ?? "";
  }

  async createSubtasks(key: string, summaries: string[]) {
    const project = key.split("-")[0];
    let next = Math.max(...Object.keys(this.snap.tickets).map((k) => Number(k.split("-")[1]) || 0), 0) + 1;
    const keys = summaries.map(() => `${project}-${next++}`);
    this.update((s) => {
      s.tickets[key].subtasks.push(...summaries.map((summary, i) => ({ key: keys[i], summary, done: false })));
    });
    return { created: keys, error: null };
  }

  async mentionable(_key: string, query: string) {
    const q = fold(query.trim());
    return [...Object.values(P), ...EXTRA_PEOPLE].filter((p) => {
      const name = fold(p.name);
      return name.startsWith(q) || name.split(" ").some((part) => part.startsWith(q));
    });
  }

  async markSeen(key: string) {
    if (!this.snap.tickets[key]?.changes.length) return;
    this.update((s) => void (s.tickets[key].changes = []));
  }

  async setUnread(eventId: string, unread: boolean) {
    this.update((s) => void (this.event(s, eventId).unread = unread));
  }

  async setDone(eventId: string, done: boolean) {
    this.update((s) => {
      const e = this.event(s, eventId);
      e.doneAt = done ? new Date().toISOString() : null;
      if (done) {
        e.unread = false;
        e.snoozedUntil = null;
      }
    });
  }

  async snooze(eventId: string, until: Date | null) {
    this.update((s) => {
      const e = this.event(s, eventId);
      e.snoozedUntil = until?.toISOString() ?? null;
      if (until) e.unread = false;
    });
  }

  async syncNow() {
    const [kind, key, who, text] = SIMULATED[this.simulated++ % SIMULATED.length];
    this.update((s) => {
      const actor = P[who];
      s.events.push({
        id: id(),
        kind,
        ticketKey: key,
        actor,
        at: new Date().toISOString(),
        text,
        unread: true,
        doneAt: null,
        snoozedUntil: null,
      });
      s.tickets[key].comments.push({ id: id(), author: actor, created: new Date().toISOString(), body: text });
      s.lastSyncAt = new Date().toISOString();
    });
  }

  async openUrl(url: string) {
    if (isTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  }
}
