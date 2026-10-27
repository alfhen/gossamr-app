import { type Intent, type Proposal, type Run, type WorkstreamView } from "../types";
import { permissionRequest } from "../workspace/agentsLogic";
import { failureHelp } from "../workspace/failureHelp";
import { docText } from "./docs";
import { inWorkstreamPane, targetOf, workstreamOf } from "./proposals";
import { maskSecrets } from "./riskyText";
import { pausedText } from "./workstreamPause";
import { roleLabel, stepOf } from "./roles";
import { runWorkstream } from "./workstreamStage";

/**
 * Needs you: the one place that says what waits on the person, and the only source of its count. It reads what the stores
 * pause (proposals, runs, workstreams with their pauses, and the failures the person dismissed) and decides
 * nothing. Every screen that counts or lists what needs the person counts these and lists these, as docs/needs-you.md says.
 */

/** What the person is being asked to do: decide a direction, unblock something stuck, or approve a draft. */
export type NeedGroupKind = "decide" | "unblock" | "approve";

export type NeedKind =
  | "plan"
  | "description"
  | "permission"
  | "question"
  | "signIn"
  | "failure"
  | "paused"
  | "draft"
  | "review"
  | "pipAsk";

/** What the person can do about a need, as the keys and the pane's buttons name it. */
export type NeedActionId = "approve" | "dismiss" | "edit" | "retry" | "resume" | "answer" | "reply" | "open";

export interface ActionSpec {
  id: NeedActionId;
  label: string;
}

/**
 * What a need brings into view in its workstream's detail: a draft's card, a run's card, or the workstream's own controls.
 */
export type NeedTarget = { type: "draft"; id: string } | { type: "run"; id: string } | { type: "workstream" };

/** One thing waiting on the person. `workstreamId` null is General. */
export interface Need {
  /** Unique across the list: the kind of thing and its id. */
  key: string;
  group: NeedGroupKind;
  kind: NeedKind;
  workstreamId: string | null;
  /** The run it is about, for a need that is a run's. */
  runId?: string;
  /** The ticket it is about, when it has one. */
  ticketKey?: string;
  /** "KEY · its title" when the title is known, else the key; null when it is about no ticket. */
  head: string | null;
  /** The title of the workstream it is in, less the ticket's key; absent for General. */
  workstreamTitle?: string;
  /** What it is, in a few words: "R1 asks a question", "Draft comment", "Paused". */
  title: string;
  /** One plain sentence: why the person is asked. */
  why: string;
  /** One plain sentence: what happens meanwhile. */
  ifYouWait: string;
  /** When it started waiting, as an ISO time. */
  at: string;
  primary: ActionSpec;
  secondary: ActionSpec[];
  target: NeedTarget;
  /** A pending comment, move or subtasks draft, which "Approve N safe drafts" may approve together with the others in its workstream. */
  batchable: boolean;
}

/** What the palette's entry for a need's workstream says, named for where it goes: a need outside any workstream opens No workstream's detail, or the run itself. */
export const openInWorkstreamLabel = (need: Pick<Need, "workstreamId" | "target">) =>
  need.workstreamId ? "Open in workstream" : need.target.type === "run" ? "Open the run" : "Open under No workstream";

export interface NeedsInput {
  /** The open workstreams; a closed one's waits go to General. */
  workstreams: readonly WorkstreamView[];
  runs: readonly Run[];
  proposals: readonly Proposal[];
  /** The runs whose failure (or stop, or unclear state) the person dismissed. They are the only way a failure goes without being dealt with. */
  dismissed: ReadonlySet<string>;
  /** When each paused workstream was last paused, by id, where that is known; otherwise its `createdAt` stands in. */
  pausedAt?: Readonly<Record<string, string>>;
  /** A ticket's title by its key, when it is cached. */
  titleOf?(key: string): string | null | undefined;
}

/** One workstream's needs, or General's: what its row shows, and what expanding it lists. */
export interface NeedGroup {
  /** The workstream's id; null is General. */
  workstreamId: string | null;
  ticketKey: string | null;
  /** The ticket's title, or the workstream's; "General" for General. */
  title: string;
  /** The highest-ranked need. */
  top: Need;
  /** The others, in rank order. */
  rest: Need[];
  /** `top` and `rest`. */
  count: number;
  /** The batchable pending drafts, offered together as "Approve N" when there are two or more. */
  safeBatch: Need[];
}

export const GENERAL_TITLE = "General";

/** Where a group sorts: decide, then unblock, then approve. */
export const GROUP_RANK: Record<NeedGroupKind, number> = { decide: 0, unblock: 1, approve: 2 };

export const GROUP_LABEL: Record<NeedGroupKind, string> = { decide: "Decide", unblock: "Unblock", approve: "Approve" };

/**
 * The chip on one need's row: its group's name, except in Approve, where it is the verb of the need's main button, so the tag
 * and the button say the same thing: "Post" for a GitHub review ("Post review"). The group itself stays Approve.
 */
export const chipLabel = (need: Pick<Need, "group" | "kind"> & { primary?: Pick<ActionSpec, "label"> }): string => {
  if (need.group !== "approve") return GROUP_LABEL[need.group];
  const verb = need.primary?.label.split(" ")[0];
  return verb || (need.kind === "review" ? "Post" : GROUP_LABEL.approve);
};

/** Drafts that may be approved together: pending comments, moves and subtasks. A description rewrite is read in its diff first, so never. */
export const BATCHABLE: ReadonlySet<Intent["type"]> = new Set(["comment", "transition", "subtasks"]);

/** Whether `p` may be approved with the others in "Approve N safe drafts": a batchable kind. */
export const safeToBatch = (p: Proposal) => BATCHABLE.has(p.intent.type);

/**
 * The pending comments among `drafts` (in order) that say what an earlier one already says on the same ticket, as the same
 * words once spacing and case are set aside. Posting both would put one comment on the ticket twice, so a batch takes the
 * first and leaves these to be decided one by one.
 */
export function repeatedComments(drafts: readonly Proposal[]): Proposal[] {
  const seen = new Set<string>();
  return drafts.filter((p) => {
    // A superseded draft is not in the batch and its replacement is the one shown, so its text must not count as seen.
    if (p.state.type !== "pending" || p.supersededBy || p.intent.type !== "comment" || !safeToBatch(p)) return false;
    const words = (p.intent.body?.blocks ? docText(p.intent.body) : "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!words) return false;
    const key = `${p.intent.item.connectionId}:${p.intent.item.externalId}\n${words}`;
    const again = seen.has(key);
    seen.add(key);
    return again;
  });
}

/** A left-out comment as the confirm names it: its title, then the first words of its text quoted, since comments on one ticket share a title. */
export function leftOutLabel(p: Proposal, title: string): string {
  const text = p.intent.type === "comment" && p.intent.body?.blocks ? docText(p.intent.body).replace(/\s+/g, " ").trim() : "";
  if (!text) return title;
  const words = [...text];
  return `${title} “${words.length > 40 ? `${words.slice(0, 40).join("").trimEnd()}…` : text}”`;
}

/** What the batch confirm says of a comment it left out because an earlier one has the same text. */
export const REPEATED_COMMENT_NOTE = "Same text as the comment above, left out";

/** What a sign-in need reads: the run, then this. */
export const SIGN_IN_TEXT = "needs you to sign in to Claude";

/** Highest rank first: decide, unblock, approve; within a group oldest first, then by key. */
export function byRank(a: Pick<Need, "group" | "at" | "key">, b: Pick<Need, "group" | "at" | "key">): number {
  return GROUP_RANK[a.group] - GROUP_RANK[b.group] || Date.parse(a.at) - Date.parse(b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** The draft kinds that start or message an agent, which Pip does directly now: stored ones are history and never need the person. */
const AGENT_DRAFTS: ReadonlySet<Intent["type"]> = new Set(["startRun", "followUp", "runAnswer"]);

type Drafted = Exclude<Intent["type"], "startRun" | "followUp" | "runAnswer">;

const DRAFT_TEXT: Record<Drafted, string> = {
  comment: "Draft comment",
  transition: "Draft move",
  subtasks: "Draft subtasks",
  create: "Draft ticket",
  link: "Draft link",
  update: "Draft change",
  rewrite: "Draft rewrite",
  githubReview: "Draft review",
};

/** What a draft is, for "Pip drafted <this>." */
const DRAFT_WHAT: Record<Drafted, (key: string | undefined) => string> = {
  comment: (k) => (k ? `a comment on ${k}` : "a comment"),
  transition: (k) => (k ? `a move of ${k}` : "a move"),
  subtasks: (k) => (k ? `subtasks under ${k}` : "subtasks"),
  create: () => "a new ticket",
  link: (k) => (k ? `a link on ${k}` : "a link"),
  update: (k) => (k ? `a change to ${k}` : "a change"),
  rewrite: (k) => (k ? `a new description for ${k}` : "a new description"),
  githubReview: () => "a GitHub review",
};

/** The open workstream a draft belongs to: the one it was made in, else the first whose conversation shows it; null is General. */
function draftWorkstream(p: Proposal, open: readonly WorkstreamView[]): string | null {
  const made = workstreamOf(p);
  if (made && open.some((v) => v.workstream.id === made)) return made;
  return open.find((v) => inWorkstreamPane(p, v.workstream))?.workstream.id ?? null;
}

/** "R2" in its workstream, else the run's role. */
function runName(run: Run, ws: WorkstreamView | null): string {
  return ws?.labels.find(([id]) => id === run.id)?.[1] ?? `${roleLabel(run.spec.role)} agent`;
}

/** The title a workstream gives its ticket, which it took when it opened: "KEY title" less the key. */
const lessKey = (title: string, key: string | null) => (key && title.startsWith(`${key} `) ? title.slice(key.length).trim() : key && title === key ? "" : title);

function workstreamTitles(workstreams: readonly WorkstreamView[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { workstream: w } of workstreams) {
    const rest = w.itemKey && w.title.startsWith(`${w.itemKey} `) ? w.title.slice(w.itemKey.length).trim() : "";
    if (w.itemKey && rest && !out.has(w.itemKey)) out.set(w.itemKey, rest);
  }
  return out;
}

/**
 * A ticket's title from the snapshot of it a run carries ("KEY: title" on its first line, as the backend
 * writes it), for a ticket outside the watched projects that no cache holds; null when the snapshot doesn't say.
 */
export function titleFromTicketBlock(block: string | null | undefined, key: string): string | null {
  const first = block?.trimStart().split("\n", 1)[0] ?? "";
  return first.startsWith(`${key}: `) ? first.slice(key.length + 2).trim() || null : null;
}

/** The titles runs kept of their tickets, by key: the last resort for a ticket's title. */
function snapshotTitles(runs: readonly Run[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (key: string | null | undefined, block: string | null | undefined) => {
    const title = key && !out.has(key) ? titleFromTicketBlock(block, key) : null;
    if (key && title) out.set(key, title);
  };
  for (const r of runs) add(r.item?.key, r.spec.ticketBlock);
  return out;
}

/** A draft that still waits for the person: pending, and not replaced by a newer one. */
const live = (p: Proposal) => p.state.type === "pending" && !p.supersededBy;

const clip = (text: string, max = 110) => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

const action = (id: NeedActionId, label: string): ActionSpec => ({ id, label });

/** `text` as one clipped sentence with a final stop. */
const sentence = (text: string) => clip(text).replace(/[.!?…]+$/, "") + ".";

/** The draft intents whose card has an Edit. */
const EDITABLE: ReadonlySet<Intent["type"]> = new Set(["comment", "rewrite", "create", "subtasks", "githubReview"]);

/** A comment draft with no run behind it, told apart by its first words (a secret masked first): `Draft comment: “Thanks for the…”`. */
function commentTitle(body: Parameters<typeof docText>[0]): string {
  return commentTitleOf(docText(body));
}

/** `commentTitle` of text as it stands, and a Needs you row's title with the comment's words as edited: only a comment with no run behind it is titled by them. */
export const commentTitleOf = (text: string): string => {
  const words = maskSecrets(text).trim().split(/\s+/).filter(Boolean);
  return words.length ? `${DRAFT_TEXT.comment}: “${words.slice(0, COMMENT_WORDS).join(" ")}${words.length > COMMENT_WORDS ? "…" : ""}”` : DRAFT_TEXT.comment;
};
export const editedTitle = (title: string, text: string | undefined): string => (text !== undefined && title.startsWith(DRAFT_TEXT.comment) ? commentTitleOf(text) : title);
const COMMENT_WORDS = 6;


/**
 * The runs no newer run of the same role on the same ticket (or repository of the same connection, for one without a ticket) has followed, in any
 * state: a failure only asks for a decision while it is the last word on that work, so a retry that is
 * running or finished, or one that failed the same way again, leaves exactly one run to deal with.
 */
export function latestRuns(runs: readonly Pick<Run, "id" | "item" | "spec" | "queuedAt" | "connectionId">[]): Set<string> {
  const newest = new Map<string, Pick<Run, "id" | "queuedAt">>();
  for (const run of runs) {
    const key = `${run.item ? `${run.item.connectionId}\n${run.item.externalId}` : `${run.connectionId}\n${run.spec.repo}`}\n${stepOf(run.spec.role) ?? run.spec.role}`;
    const seen = newest.get(key);
    if (!seen || run.queuedAt > seen.queuedAt || (run.queuedAt === seen.queuedAt && run.id > seen.id)) newest.set(key, run);
  }
  return new Set([...newest.values()].map((r) => r.id));
}

/**
 * Everything waiting on the person across the open workstreams and General, highest rank first: a decision (a plan or
 * description to approve, a ticket the triage found not clear enough to plan), then what is stuck (a permission, a question,
 * a sign-in, a failure, a paused workstream, a question Pip asked), then drafts to approve (a
 * Jira draft, a GitHub review). Within a group, oldest first.
 *
 * A retired or superseded draft never shows. A failure is a need only
 * while it is the latest run of its role on its ticket (`latestRuns`), and stays until the person deals with it: Retry, a
 * fix, or a Dismiss (`dismissed`); looking at it clears nothing. A finished run is a state, not a need.
 */
export function needs({ workstreams, runs, proposals, dismissed, pausedAt, titleOf }: NeedsInput): Need[] {
  const kept = workstreamTitles(workstreams);
  const snapped = snapshotTitles(runs);
  const titleFor = (key: string | null | undefined) => (key ? titleOf?.(key)?.trim() || kept.get(key) || snapped.get(key) : undefined);
  const open = workstreams.filter((v) => v.workstream.closedAt === null);
  const byId = new Map(open.map((v) => [v.workstream.id, v]));
  /** What every need carries of where it is and which ticket it is about. */
  const where = (workstreamId: string | null, key: string | null | undefined) => {
    const ws = workstreamId ? byId.get(workstreamId) : undefined;
    const ticketKey = key ?? ws?.workstream.itemKey ?? undefined;
    const title = titleFor(ticketKey);
    const own = ws ? lessKey(ws.workstream.title, ws.workstream.itemKey) : "";
    return {
      workstreamId,
      ...(ticketKey ? { ticketKey } : {}),
      head: ticketKey ? (title ? `${ticketKey} · ${title}` : ticketKey) : null,
      ...(ws ? { workstreamTitle: own || title || ws.workstream.title } : {}),
    };
  };
  const out: Need[] = [];
  const latest = latestRuns(runs);

  const repeated = new Set(repeatedComments([...proposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))).map((p) => p.id));
  for (const p of proposals) {
    if (!live(p) || AGENT_DRAFTS.has(p.intent.type)) continue;
    const workstreamId = draftWorkstream(p, open);
    const ws = workstreamId ? byId.get(workstreamId) : undefined;
    const target = { type: "draft", id: p.id } as const;
    const key = targetOf(p.intent)?.key;
    const base = { key: `draft:${p.id}`, at: p.createdAt, target, ...where(workstreamId, key) };
    // A draft a run left says which run, so a review's comments can be told apart: "R5 review · comment".
    const from = p.origin.type === "run" ? p.origin.runId : null;
    const label = from && ws?.labels.find(([id]) => id === from)?.[1];
    const step = from ? runs.find((r) => r.id === from)?.spec.role : undefined;
    // "GitHub review", not "review": beside a Review run's stage it would read "Review · review".
    const intent = p.intent.type as Drafted;
    const what = intent === "githubReview" ? "GitHub review" : DRAFT_TEXT[intent].replace(/^Draft /, "");
    const title = label ? (step ? `${label} ${step} · ${what}` : `${label} ${what}`) : step ? `${roleLabel(step)} · ${what}` : p.intent.type === "comment" && !from ? commentTitle(p.intent.body) : DRAFT_TEXT[intent];
    const by = label ? (step ? `${label} ${step}` : label) : p.createdBy === "pip" ? "Pip" : p.createdBy === "agent" ? "An agent" : "You";
    const drafted = `${by} drafted ${DRAFT_WHAT[intent](key)}.`;
    const edit = EDITABLE.has(p.intent.type) ? [action("edit", "Edit")] : [];
    if (p.intent.type === "rewrite") {
      // A plan run's description update is how the plan is approved; any other rewrite is read in its diff first.
      const plan = from !== null && stepOf(runs.find((r) => r.id === from)?.spec.role ?? "") === "plan" && !!p.intent.body;
      // A Triage's description update stands where its comment did: a draft that waits for a go-ahead, read in its diff first
      // (never in a batch), and nothing the workstream waits on, so it does not outrank the question or the wait it sits beside.
      const triage = from !== null && stepOf(step ?? "") === "triage" && !!p.intent.body;
      out.push({
        ...base,
        group: triage ? "approve" : "decide",
        kind: plan ? "plan" : "description",
        title: plan ? "Approve the plan" : title,
        why: plan ? `${label ? "An agent" : by} wrote the plan${key ? ` for ${key}` : ""}${label ? ` (run ${label})` : ""}; approving its description update is how the plan is approved.` : drafted,
        ifYouWait: plan ? "Build doesn't start until the plan is approved; nothing is written to Jira." : "Nothing is written to Jira until you approve it.",
        primary: action("approve", "Approve"),
        secondary: [...edit, action("dismiss", "Skip")],
        batchable: false,
      });
      continue;
    }
    const review = p.intent.type === "githubReview";
    out.push({
      ...base,
      group: "approve",
      kind: review ? "review" : "draft",
      title,
      why: drafted,
      ifYouWait: review ? "Nothing is posted to GitHub until you choose." : "Nothing is written to Jira until you approve it.",
      primary: action("approve", review ? "Post review" : p.intent.type === "comment" ? "Post comment" : "Approve"),
      secondary: [...edit, action("dismiss", "Skip")],
      batchable: safeToBatch(p) && !repeated.has(p.id),
    });
  }

  for (const run of runs) {
    if (run.archivedAt) continue;
    const ws = runWorkstream(open, run);
    const name = runName(run, ws);
    const at = run.endedAt ?? run.lastProgressAt;
    const key = run.item?.key;
    const base = { key: `run:${run.id}`, runId: run.id, at, target: { type: "run", id: run.id } as const, ...where(ws?.workstream.id ?? null, key) };
    const stays = base.ticketKey ? `nothing else in ${base.ticketKey} moves` : "nothing else it blocks moves";
    if (run.state === "needsAnswer") {
      out.push({
        ...base,
        group: "unblock",
        kind: "question",
        title: `${name} asks a question`,
        why: `${name} asks: “${clip(run.needs?.trim() || "it is waiting for you", 90)}”`,
        ifYouWait: `The run stays paused until you answer; ${stays}.`,
        primary: action("answer", "Answer"),
        secondary: [],
        batchable: false,
      });
    } else if (run.state === "needsPermission") {
      const ask = permissionRequest(run.needs);
      const command = ask?.command ?? "";
      const wants = !command ? `${name} asks permission.` : ask?.tool && ask.tool !== "Bash" ? `${name} wants to use ${ask.tool} on \`${clip(command, 90)}\`.` : `${name} wants to run \`${clip(command, 90)}\`.`;
      out.push({
        ...base,
        group: "unblock",
        kind: "permission",
        title: `${name} asks to run a command`,
        why: wants,
        ifYouWait: `The run stays paused; ${stays}.`,
        primary: action("open", "Open in Terminal"),
        secondary: [],
        batchable: false,
      });
    } else if (run.state === "systemBlocked") {
      out.push({
        ...base,
        group: "unblock",
        kind: "signIn",
        title: `${name} ${SIGN_IN_TEXT}`,
        why: `${name} ${SIGN_IN_TEXT}.`,
        ifYouWait: `The run stays blocked; ${stays}.`,
        primary: action("open", "Open Terminal to sign in"),
        secondary: [],
        batchable: false,
      });
    } else if (run.state === "failed" && !dismissed.has(run.id) && latest.has(run.id)) {
      const trust = run.failure?.type === "untrustedFolder";
      const help = failureHelp(run);
      out.push({
        ...base,
        group: "unblock",
        kind: "failure",
        title: trust ? `${name} needs its folder trusted` : `${name} failed`,
        why: `${name} ${trust ? "can't start until its folder is trusted" : "failed"}: ${sentence(help?.summary ?? (run.error?.trim() || "no reason was recorded"))}`,
        ifYouWait: "Nothing retries by itself; it stays here until you retry or dismiss it.",
        primary: help?.primary ? action("open", help.primary.label) : action("retry", run.shortId ? "Open in Terminal" : "Retry"),
        secondary: [action("dismiss", "Dismiss")],
        batchable: false,
      });
    }
  }

  for (const v of open) {
    if (!v.pipAsk) continue;
    const id = v.workstream.id;
    out.push({
      key: `pip-ask:${id}`,
      group: "decide",
      kind: "pipAsk",
      ...where(id, v.workstream.itemKey),
      title: "Pip asks you",
      why: `Pip asks: “${clip(v.pipAsk.question, 140)}”`,
      ifYouWait: "Pip waits for your answer in the conversation.",
      at: v.pipAsk.at,
      primary: action("reply", "Answer in Pip"),
      secondary: [action("dismiss", "Dismiss")],
      target: { type: "workstream" },
      batchable: false,
    });
  }

  for (const v of open) {
    const reason = v.workstream.pausedReason;
    const paused = pausedText(reason);
    if (!reason || !paused) continue;
    const id = v.workstream.id;
    out.push({
      key: `paused:${id}`,
      group: "unblock",
      kind: "paused",
      ...where(id, v.workstream.itemKey),
      title: paused,
      why: reason === "ceiling" ? "Pip was woken too often today, so Gossamr paused it." : "You paused it.",
      ifYouWait: "Pip isn't woken; its agents carry on.",
      at: pausedAt?.[id] ?? v.workstream.createdAt,
      primary: action("resume", "Resume"),
      secondary: [],
      target: { type: "workstream" },
      batchable: false,
    });
  }

  return out.sort(byRank);
}

/** How many of `list` wait in workstream `workstreamId`; null counts General's. */
export function needsIn(list: readonly Pick<Need, "workstreamId">[], workstreamId: string | null): number {
  return list.filter((n) => n.workstreamId === workstreamId).length;
}

/**
 * The needs by where they are: one group per workstream with any, and General's, the group whose top need ranks highest
 * first. A group's `top` is its highest-ranked need, `rest` the others in order, and `safeBatch` its batchable pending
 * drafts, which may be approved together.
 */
export function needGroups(list: readonly Need[]): NeedGroup[] {
  const by = new Map<string | null, Need[]>();
  for (const n of [...list].sort(byRank)) by.set(n.workstreamId, [...(by.get(n.workstreamId) ?? []), n]);
  const groups: NeedGroup[] = [];
  for (const [workstreamId, all] of by) {
    const [top, ...rest] = all;
    groups.push({
      workstreamId,
      ticketKey: workstreamId === null ? null : (top.ticketKey ?? null),
      title: workstreamId === null ? GENERAL_TITLE : (top.workstreamTitle ?? top.head ?? top.title),
      top,
      rest,
      count: all.length,
      safeBatch: all.filter((n) => n.batchable),
    });
  }
  return groups.sort((a, b) => byRank(a.top, b.top));
}

/**
 * Where the person's attention goes once the need `removed` is dealt with: the need that followed it in `previous` (the
 * keys as the list ordered them), else the top of the list that is left (the list wraps); null when none is left.
 */
export function needAfter<T extends Pick<Need, "key">>(previous: readonly string[], removed: string, current: readonly T[]): T | null {
  const now = new Map(current.map((n) => [n.key, n]));
  const at = previous.indexOf(removed);
  if (at >= 0) {
    for (let i = at + 1; i < previous.length; i++) if (now.has(previous[i])) return now.get(previous[i])!;
    const first = previous.find((k) => now.has(k));
    if (first !== undefined) return now.get(first)!;
  }
  return current[0] ?? null;
}

/**
 * The need to point the person at while they read `open`: the top-ranked need that ranks above it, came in after it was
 * opened (is not in `seen`, the keys when it opened) and is a Decide or an Unblock. Null when there is none.
 */
export function higherPriority<T extends Pick<Need, "key" | "group" | "at">>(list: readonly T[], open: string, seen: ReadonlySet<string>): T | null {
  const ranked = [...list].sort(byRank);
  const at = ranked.findIndex((n) => n.key === open);
  if (at < 0) return null;
  return ranked.slice(0, at).find((n) => !seen.has(n.key) && (n.group === "decide" || n.group === "unblock")) ?? null;
}
