import { ALLOW_MORE_STEPS, HELD_BUDGET, type Intent, type Proposal, type ReadinessStop, type Run, type WorkstreamView } from "../types";
import { quietMinutes, stoppedAtLimit } from "../workspace/agentsLogic";
import { failureHelp } from "../workspace/failureHelp";
import { docText } from "./docs";
import { parsePermission, permissionOffer, readAs } from "./permission";
import { inWorkstreamPane, isAnswersDraft, isReporterNudge, isReporterQuestions, targetOf, workstreamOf } from "./proposals";
import { humanDuration } from "./runNames";
import { agoText, type ReporterAsk } from "./reporterWait";
import { maskSecrets } from "./riskyText";
import { isHeldByYou, shortHeld, stepsOf } from "./workstreamHold";
import { STAGE_LABEL, runWorkstream } from "./workstreamStage";

/**
 * Needs you: the one place that says what waits on the person, and the only source of its count. It reads what the stores
 * hold (proposals, runs, workstreams with their holds and escalations, and the failures the person dismissed) and decides
 * nothing. Every screen that counts or lists what needs the person counts these and lists these, as docs/needs-you.md says.
 */

/** What the person is being asked to do: decide a direction, unblock something stuck, or approve a draft. */
export type NeedGroupKind = "decide" | "unblock" | "approve";

export type NeedKind =
  | "escalation"
  | "plan"
  | "description"
  | "permission"
  | "question"
  | "signIn"
  | "failure"
  | "stoppedAtLimit"
  | "quiet"
  | "unknown"
  | "continuation"
  | "hold"
  | "budget"
  | "readiness"
  | "draft"
  | "review"
  | "runStart";

/** What the person can do about a need, as the keys and the pane's buttons name it. */
export type NeedActionId = "approve" | "allow" | "deny" | "dismiss" | "edit" | "retry" | "resume" | "allowMore" | "advise" | "askReporter" | "answerSelf" | "planAnyway" | "answer" | "open";

export interface ActionSpec {
  id: NeedActionId;
  label: string;
}

/**
 * What a need brings into view on Pip home: a draft's card, a run's card, the workstream's held banner, or the card of a
 * review that still blocks after the fix rounds.
 */
export type NeedTarget = { type: "draft"; id: string } | { type: "run"; id: string } | { type: "workstream" } | { type: "escalation" };

/** One thing waiting on the person. `workstreamId` null is General. */
export interface Need {
  /** Unique across the list: the kind of thing and its id. */
  key: string;
  group: NeedGroupKind;
  kind: NeedKind;
  workstreamId: string | null;
  /** The run it is about, for a need that is a run's (a question with a drafted reply included). */
  runId?: string;
  /** The ticket it is about, when it has one. */
  ticketKey?: string;
  /** "KEY · its title" when the title is known, else the key; null when it is about no ticket. */
  head: string | null;
  /** The title of the workstream it is in, less the ticket's key; absent for General. */
  workstreamTitle?: string;
  /** What it is, in a few words: "R1 asks a question", "Draft comment", "Held by you". */
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

/**
 * What the pane's link and the palette call `openInWorkstream`, named for where it goes: a need in General has no workstream to
 * open, so a run's need opens the run and any other shows the General timeline.
 */
export const openInWorkstreamLabel = (need: Pick<Need, "workstreamId" | "target">) =>
  need.workstreamId ? "Open in workstream" : need.target.type === "run" ? "Open the run" : "Show in General timeline";

export interface NeedsInput {
  /** The open workstreams; a closed one's waits go to General. */
  workstreams: readonly WorkstreamView[];
  runs: readonly Run[];
  proposals: readonly Proposal[];
  /** The runs whose failure (or stop, or unclear state) the person dismissed. They are the only way a failure goes without being dealt with. */
  dismissed: ReadonlySet<string>;
  /** When the reporter was asked, and nudged, by workstream id, where that is known (`reporterAsk`): the readiness decision says so. */
  asked?: Readonly<Record<string, ReporterAsk>>;
  /** When each held workstream was last held, by id, where that is known; otherwise its `createdAt` stands in. */
  heldAt?: Readonly<Record<string, string>>;
  /** A ticket's title by its key, when it is cached. */
  titleOf?(key: string): string | null | undefined;
  /** The time the quiet runs are judged by, in ms. */
  now: number;
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
 * and the button say the same thing: "Post" for a GitHub review ("Post review"), "Send" for an answer, "Review" for an agent to start
 * ("Review and start"). The group itself stays Approve.
 */
export const chipLabel = (need: Pick<Need, "group" | "kind"> & { primary?: Pick<ActionSpec, "label"> }): string => {
  if (need.group !== "approve") return GROUP_LABEL[need.group];
  const verb = need.primary?.label.split(" ")[0];
  return verb || (need.kind === "review" ? "Post" : need.kind === "runStart" ? "Review" : GROUP_LABEL.approve);
};

/** Drafts that may be approved together: pending comments, moves and subtasks. A description rewrite is read in its diff first, and a run or follow-up after its prompt or message, so never. */
export const BATCHABLE: ReadonlySet<Intent["type"]> = new Set(["comment", "transition", "subtasks"]);

/**
 * Whether `p` may be approved with the others in "Approve N safe drafts": a batchable kind, but never the questions to a
 * reporter, the nudge that follows them up, or Pip's comment with the person's answers, which are read and approved on their own before they reach Jira.
 */
export const safeToBatch = (p: Proposal) => BATCHABLE.has(p.intent.type) && !isReporterQuestions(p) && !isReporterNudge(p) && !isAnswersDraft(p);

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

/** What the list says of a review that still blocks after the automatic fix rounds. */
export const escalationReason = (rounds: number) => `Review still blocks after ${rounds} fix ${rounds === 1 ? "round" : "rounds"}`;

/** What a readiness need says of the open questions: which triage left them and what they are, in one sentence. */
export function readinessWhy(r: Pick<ReadinessStop, "triageLabel" | "questions">): string {
  const triage = r.triageLabel || "The triage";
  if (r.questions.length === 0) return `${triage} found the ticket unclear but listed no questions.`;
  return clip(`${triage} left ${r.questions.length === 1 ? "this question" : "these questions"} open: ${r.questions.join(" · ")}`, 240);
}

/**
 * What "I'll answer" puts in the composer, which is one line: the open questions quoted, then where to answer. A question
 * is the triage's own words, so each is quoted as data and the person writes after "My answers:".
 */
export function readinessPrompt(r: Pick<ReadinessStop, "triageLabel" | "questions">, key: string | null | undefined): string {
  const triage = r.triageLabel || "The triage";
  const quoted = r.questions.length ? r.questions.map((q) => `“${q}”`).join(" · ") : "“(it listed no questions)”";
  return `${triage}'s open questions about ${key ?? "this ticket"}: ${quoted}. My answers: `;
}

/** What a sign-in need reads: the run, then this. */
export const SIGN_IN_TEXT = "needs you to sign in to Claude";

/** Highest rank first: decide, unblock, approve; within a group oldest first, then by key. */
export function byRank(a: Pick<Need, "group" | "at" | "key">, b: Pick<Need, "group" | "at" | "key">): number {
  return GROUP_RANK[a.group] - GROUP_RANK[b.group] || Date.parse(a.at) - Date.parse(b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

const DRAFT_TEXT: Record<Exclude<Intent["type"], "startRun">, string> = {
  comment: "Draft comment",
  transition: "Draft move",
  subtasks: "Draft subtasks",
  create: "Draft ticket",
  link: "Draft link",
  update: "Draft change",
  rewrite: "Draft rewrite",
  followUp: "Draft follow-up",
  runAnswer: "Draft answer",
  githubReview: "Draft review",
};

/** What a draft is, for "Pip drafted <this>." */
const DRAFT_WHAT: Record<Exclude<Intent["type"], "startRun">, (key: string | undefined) => string> = {
  comment: (k) => (k ? `a comment on ${k}` : "a comment"),
  transition: (k) => (k ? `a move of ${k}` : "a move"),
  subtasks: (k) => (k ? `subtasks under ${k}` : "subtasks"),
  create: () => "a new ticket",
  link: (k) => (k ? `a link on ${k}` : "a link"),
  update: (k) => (k ? `a change to ${k}` : "a change"),
  rewrite: (k) => (k ? `a new description for ${k}` : "a new description"),
  followUp: () => "a follow-up for a run",
  runAnswer: () => "an answer for a run",
  githubReview: () => "a GitHub review",
};

/** The open workstream a draft belongs to: the one it was made in, else the first whose conversation shows it; null is General. */
function draftWorkstream(p: Proposal, open: readonly WorkstreamView[]): string | null {
  const made = workstreamOf(p);
  if (made && open.some((v) => v.workstream.id === made)) return made;
  return open.find((v) => inWorkstreamPane(p, v.workstream))?.workstream.id ?? null;
}

/** "R2" in its workstream, else the run's kind. */
function runName(run: Run, ws: WorkstreamView | null): string {
  return ws?.labels.find(([id]) => id === run.id)?.[1] ?? `${STAGE_LABEL[run.spec.kind]} agent`;
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
 * A ticket's title from the snapshot of it a run or a run draft carries ("KEY: title" on its first line, as the backend
 * writes it), for a ticket outside the watched projects that no cache holds; null when the snapshot doesn't say.
 */
export function titleFromTicketBlock(block: string | null | undefined, key: string): string | null {
  const first = block?.trimStart().split("\n", 1)[0] ?? "";
  return first.startsWith(`${key}: `) ? first.slice(key.length + 2).trim() || null : null;
}

/** The titles runs and run drafts kept of their tickets, by key: the last resort for a ticket's title. */
function snapshotTitles(runs: readonly Run[], proposals: readonly Proposal[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (key: string | null | undefined, block: string | null | undefined) => {
    const title = key && !out.has(key) ? titleFromTicketBlock(block, key) : null;
    if (key && title) out.set(key, title);
  };
  for (const r of runs) add(r.item?.key, r.spec.ticketBlock);
  for (const p of proposals) if (p.intent.type === "startRun") add(p.intent.item?.key, p.intent.spec.ticketBlock);
  return out;
}

/** The pending answer drafts for runs still asking, by run id, the oldest when there are several: each run's question carries its one. */
function answersByRun(proposals: readonly Proposal[], runs: readonly Run[]): Map<string, Proposal> {
  const asking = new Set(runs.filter((r) => r.state === "needsAnswer").map((r) => r.id));
  const out = new Map<string, Proposal>();
  for (const p of [...proposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (live(p) && p.intent.type === "runAnswer" && asking.has(p.intent.runId) && !out.has(p.intent.runId)) out.set(p.intent.runId, p);
  }
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
const EDITABLE: ReadonlySet<Intent["type"]> = new Set(["comment", "rewrite", "create", "subtasks", "githubReview", "followUp", "runAnswer"]);

/** A comment draft with no run behind it, told apart by its first words (a secret masked first): `Draft comment: “Thanks for the…”`. */
function commentTitle(body: Parameters<typeof docText>[0]): string {
  const words = maskSecrets(docText(body)).trim().split(/\s+/).filter(Boolean);
  return words.length ? `${DRAFT_TEXT.comment}: “${words.slice(0, COMMENT_WORDS).join(" ")}${words.length > COMMENT_WORDS ? "…" : ""}”` : DRAFT_TEXT.comment;
}
const COMMENT_WORDS = 6;

/**
 * What a "Keep waiting" is remembered under: this quiet spell of the run (it ends when the run makes progress), so a later
 * quiet spell, or a failure of the same run, still needs the person.
 */
export const quietKey = (run: Pick<Run, "id" | "lastProgressAt">) => `quiet:${run.id}@${run.lastProgressAt}`;

/**
 * Everything waiting on the person across the open workstreams and General, highest rank first: a decision (an escalation,
 * a plan or description to approve, a workstream that used its automatic steps, a ticket the triage found not clear enough to plan), then what is stuck (a permission, a question, a sign-in, a failure, a run stopped at
 * its limit, gone quiet for 30 minutes, unclear or that may have carried on elsewhere, a hold the system made), then drafts to approve (a
 * Jira draft, a GitHub review, a run to start). Within a group, oldest first.
 *
 * One thing is one need: a run asking a question that has a drafted reply is the question; a review that still blocks
 * after the fix rounds carries its review draft; a retired or superseded draft never shows. A failure, a limit stop, a
 * possible continuation and an unclear run stay until the person deals with them: Retry, a fix, a resume, or a Dismiss
 * (`dismissed`); looking at them clears nothing.
 */
export function needs({ workstreams, runs, proposals, dismissed, heldAt, asked, titleOf, now }: NeedsInput): Need[] {
  const kept = workstreamTitles(workstreams);
  const snapped = snapshotTitles(runs, proposals);
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
  const answers = answersByRun(proposals, runs);
  const carried = new Set([...answers.values()].map((p) => p.id));
  // A review that still blocks carries its review draft, so the draft is not a second need.
  for (const v of open) if (v.escalation?.reviewDraft) carried.add(v.escalation.reviewDraft);

  const repeated = new Set(repeatedComments([...proposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))).map((p) => p.id));
  for (const p of proposals) {
    if (!live(p) || carried.has(p.id)) continue;
    const workstreamId = draftWorkstream(p, open);
    const ws = workstreamId ? byId.get(workstreamId) : undefined;
    const target = { type: "draft", id: p.id } as const;
    const key = targetOf(p.intent)?.key;
    const base = { key: `draft:${p.id}`, at: p.createdAt, target, ...where(workstreamId, key) };
    if (p.intent.type === "startRun") {
      const kind = STAGE_LABEL[p.intent.spec.kind];
      const maker = p.createdBy === "pip" ? "Pip" : p.createdBy === "autopilot" ? "The autopilot" : p.createdBy === "agent" ? "An agent" : "You";
      out.push({
        ...base,
        group: "approve",
        kind: "runStart",
        title: `Start ${kind}`,
        why: `${maker} drafted ${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} agent${key ? ` for ${key}` : ""}; it starts only when you approve it.`,
        ifYouWait: "Nothing starts until you approve it.",
        primary: action("open", "Review and start"),
        secondary: [action("dismiss", "Skip")],
        batchable: false,
      });
      continue;
    }
    // A draft a run left says which run, so a review's comments can be told apart: "R5 review · comment".
    const from = p.origin.type === "run" ? p.origin.runId : null;
    const label = from && ws?.labels.find(([id]) => id === from)?.[1];
    const step = from ? runs.find((r) => r.id === from)?.spec.kind : undefined;
    // "GitHub review", not "review": beside a Review run's stage it would read "Review · review".
    const what = p.intent.type === "githubReview" ? "GitHub review" : DRAFT_TEXT[p.intent.type].replace(/^Draft /, "");
    const title = isReporterQuestions(p) ? "Questions for the reporter" : isReporterNudge(p) ? "Nudge for the reporter" : isAnswersDraft(p) ? "Answers to the open questions" : label ? (step ? `${label} ${STAGE_LABEL[step].toLowerCase()} · ${what}` : `${label} ${what}`) : step ? `${STAGE_LABEL[step]} · ${what}` : p.intent.type === "comment" && !from ? commentTitle(p.intent.body) : DRAFT_TEXT[p.intent.type];
    const by = label ? (step ? `${label} ${STAGE_LABEL[step].toLowerCase()}` : label) : p.createdBy === "pip" ? "Pip" : p.createdBy === "autopilot" ? "The autopilot" : p.createdBy === "agent" ? "An agent" : "You";
    // The questions to a reporter are Gossamr's words around the triage's own, and the person's choice: say so.
    const asked = isReporterQuestions(p);
    const drafted = asked
      ? `Gossamr drafted a comment to the reporter${key ? ` of ${key}` : ""}${label ? ` from ${label}'s open questions` : " from what the ticket leaves out"}; it is posted only when you approve it.`
      : isReporterNudge(p)
        ? `Gossamr drafted a gentle nudge to the reporter${key ? ` of ${key}` : ""}, who hasn't answered; it is posted only when you approve it.`
        : isAnswersDraft(p)
          ? `Pip drafted a comment${key ? ` on ${key}` : ""} with your answers to the open questions; it is posted only when you approve it.`
          : `${by} drafted ${DRAFT_WHAT[p.intent.type](key)}.`;
    const edit = EDITABLE.has(p.intent.type) ? [action("edit", "Edit")] : [];
    if (p.intent.type === "rewrite") {
      // A plan run's description update is how the plan is approved; any other rewrite is read in its diff first.
      const plan = from !== null && runs.find((r) => r.id === from)?.spec.kind === "plan" && !!p.intent.body;
      out.push({
        ...base,
        group: "decide",
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
      primary: action("approve", review ? "Post review" : p.intent.type === "runAnswer" ? "Send answer" : p.intent.type === "followUp" ? "Send back" : p.intent.type === "comment" ? "Post comment" : "Approve"),
      secondary: [...edit, action("dismiss", "Skip")],
      batchable: safeToBatch(p) && !repeated.has(p.id),
    });
  }

  for (const run of runs) {
    const ws = runWorkstream(open, run);
    const name = runName(run, ws);
    const at = run.endedAt ?? run.lastProgressAt;
    const key = run.item?.key;
    const base = { key: `run:${run.id}`, runId: run.id, at, target: { type: "run", id: run.id } as const, ...where(ws?.workstream.id ?? null, key) };
    const stays = base.ticketKey ? `nothing else in ${base.ticketKey} moves` : "nothing else it blocks moves";
    const answer = answers.get(run.id);
    if (answer) {
      out.push({
        ...base,
        key: `draft:${answer.id}`,
        target: { type: "draft", id: answer.id },
        group: "unblock",
        kind: "question",
        title: `${name} asks a question · ${answer.createdBy === "pip" ? "Pip suggests a reply" : "a reply is drafted"}`,
        why: `${name} asks: “${clip(run.needs ?? "", 90)}” ${answer.createdBy === "pip" ? "Pip suggests a reply." : "A reply is drafted."}`,
        ifYouWait: `The run stays paused; ${stays}.`,
        primary: action("approve", "Send answer"),
        secondary: [action("edit", "Edit"), action("dismiss", "Skip")],
        batchable: false,
      });
    } else if (run.state === "needsAnswer") {
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
      // A prompt the person chose Allow once for is theirs to answer in Terminal now, and stays a need until it is answered,
      // so a run left waiting there isn't forgotten. One it asks after is asked again.
      const allowed = run.permissionAllowed?.command === readAs(run.needs);
      const ask = parsePermission(run.needs);
      const command = readAs(run.needs);
      const offer = permissionOffer(run);
      const wants = !command ? `${name} asks permission.` : !ask || ask.tool === "Bash" ? `${name} wants to run \`${clip(command, 90)}\`.` : `${name} wants to use ${ask.tool} on \`${clip(command, 90)}\`.`;
      out.push({
        ...base,
        group: "unblock",
        kind: "permission",
        title: allowed ? `${name} waits for your Yes in Terminal` : `${name} asks to run a command`,
        why: allowed ? `${name} waits for your Yes in Terminal for \`${clip(command, 90)}\`.` : wants,
        ifYouWait: `The run stays paused; ${stays}.`,
        primary: allowed ? action("open", "Open in Terminal") : offer.allow === "offered" ? action("allow", "Allow once in Terminal") : action("deny", "Deny"),
        secondary: allowed || offer.allow === "offered" ? [action("deny", "Deny")] : [],
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
    } else if (run.state === "failed" && !dismissed.has(run.id)) {
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
    } else if (run.state === "stopped" && !dismissed.has(run.id) && (stoppedAtLimit(run) || run.possibleContinuations?.length)) {
      if (stoppedAtLimit(run)) {
        out.push({
          ...base,
          group: "unblock",
          kind: "stoppedAtLimit",
          title: `${name} stopped at its limit`,
          why: `${name} was stopped at its limit: ${sentence(run.error?.trim() || "it passed its limit")}`,
          ifYouWait: "It stays stopped; its conversation and worktree are kept.",
          primary: action("resume", "Resume"),
          secondary: [action("dismiss", "Dismiss")],
          batchable: false,
        });
      } else {
        out.push({
          ...base,
          group: "unblock",
          kind: "continuation",
          title: `${name} may have continued in another session`,
          why: `${name} stopped, and a session that may be it carried on elsewhere.`,
          ifYouWait: "The run stays stopped until you adopt a session or dismiss this.",
          primary: action("open", "Adopt a session"),
          secondary: [action("dismiss", "Dismiss")],
          batchable: false,
        });
      }
    } else if (run.state === "unknown" && !dismissed.has(run.id)) {
      out.push({
        ...base,
        group: "unblock",
        kind: "unknown",
        title: `${name} is in a state Gossamr can't read`,
        why: `Gossamr can't tell what ${name} is doing.`,
        ifYouWait: "Nothing changes until you look at it in Terminal.",
        primary: action("open", "Open in Terminal"),
        secondary: [action("dismiss", "Dismiss")],
        batchable: false,
      });
    } else if (run.state === "working") {
      const quiet = quietMinutes(run, now);
      if (quiet === null || dismissed.has(quietKey(run))) continue;
      out.push({
        ...base,
        group: "unblock",
        kind: "quiet",
        title: `${name} has gone quiet`,
        why: `${name} has made no progress for ${humanDuration(quiet)}.`,
        ifYouWait: "It carries on if it is only slow; nothing is stopped for you.",
        primary: action("open", "Open in Terminal"),
        secondary: [action("dismiss", "Keep waiting")],
        batchable: false,
      });
    }
  }

  for (const v of open) {
    const held = shortHeld(v.workstream.heldReason, v.workstream.drifted);
    // A hold the person chose is not a need: they know, and the workstream's header says it with a Resume.
    if (!held || isHeldByYou(v.workstream.heldReason)) continue;
    const id = v.workstream.id;
    if (v.workstream.heldReason === HELD_BUDGET) {
      // Running out of automatic steps is a question for the person: more, or no more. In Advise nothing starts on its own, so it is answered.
      if (v.workstream.mode !== "manage") continue;
      out.push({
        key: `budget:${id}`,
        group: "decide",
        kind: "budget",
        ...where(id, v.workstream.itemKey),
        title: `${v.workstream.itemKey ?? "This workstream"} used its ${stepsOf(v.budget).limit} automatic steps`,
        why: "Pip and the automatic steps are paused until you decide.",
        ifYouWait: "Nothing more starts on its own; its agents carry on.",
        at: heldAt?.[id] ?? v.workstream.createdAt,
        primary: action("allowMore", `Allow ${ALLOW_MORE_STEPS} more`),
        secondary: [action("advise", "Switch to Advise")],
        target: { type: "workstream" },
        batchable: false,
      });
      continue;
    }
    out.push({
      key: `held:${id}`,
      group: "unblock",
      kind: "hold",
      ...where(id, v.workstream.itemKey),
      title: held,
      why: `${held}.`,
      ifYouWait: "Pip takes no turns and no automatic step starts; its agents carry on.",
      at: heldAt?.[id] ?? v.workstream.createdAt,
      primary: action("resume", "Resume"),
      secondary: [],
      target: { type: "workstream" },
      batchable: false,
    });
  }

  for (const v of open) {
    const e = v.escalation;
    if (!e) continue;
    out.push({
      key: `escalation:${e.reviewRun}`,
      group: "decide",
      kind: "escalation",
      ...where(v.workstream.id, v.workstream.itemKey),
      title: escalationReason(e.rounds),
      why: `The review still blocks after ${e.rounds} fix ${e.rounds === 1 ? "round" : "rounds"}.`,
      ifYouWait: "The build stays as it is; no more fix rounds start until you choose.",
      at: e.at,
      primary: action("open", "Choose what next"),
      secondary: [],
      target: { type: "escalation" },
      batchable: false,
    });
  }

  for (const v of open) {
    const r = v.readiness;
    if (!r) continue;
    const key = v.workstream.itemKey;
    // The ticket changed, or the reporter replied, while the person waited: the question is back, as a choice to plan now or ask again.
    // The reporter was asked before, and has not answered unless this is their reply: say so before the questions.
    const ask = v.workstream.id in (asked ?? {}) && !r.replied ? asked![v.workstream.id] : null;
    const when = new Date(now);
    const already = ask ? `You asked the reporter ${agoText(ask.asked, when)}${ask.nudged ? ` and nudged ${agoText(ask.nudged, when)}` : ""}; they have not answered. ` : "";
    out.push({
      key: `readiness:${r.triageRun}`,
      group: "decide",
      kind: "readiness",
      ...where(v.workstream.id, key),
      title: r.replied ? `${key ?? "This ticket"}: the reporter replied, plan now?` : r.changed ? `${key ?? "This ticket"} changed: plan now?` : `${key ?? "This ticket"} isn't clear enough to plan`,
      why: r.replied ? `The reporter replied on ${key ?? "the ticket"} while you waited. ${readinessWhy(r)}` : r.changed ? `${key ?? "The ticket"} changed while you waited for the reporter. ${already}${readinessWhy(r)}` : `${already}${readinessWhy(r)}`,
      ifYouWait: "No plan starts until you choose; nothing is posted to Jira.",
      at: r.at,
      primary: r.changed ? action("planAnyway", "Plan now") : action("askReporter", ask ? "Ask again" : "Ask the reporter"),
      secondary: r.changed ? [action("askReporter", "Still unclear (ask again)")] : [action("answerSelf", "I'll answer"), action("planAnyway", "Plan anyway")],
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
