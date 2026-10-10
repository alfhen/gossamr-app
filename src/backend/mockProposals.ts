import { docFromText, docText, quoteAfterFirst } from "../lib/docs";
import { BUILD_ACCOUNT_LIMIT, INSTRUCTIONS, PLAN_LIMIT, REVIEW_REPORTS } from "./mockRunKinds";
import { capRefusal, leftByRun, PLAN_IS_THE_USERS, REPLACED_REASON, supersession, targetOf, WORKSTREAM_PENDING_CAP, workstreamOf } from "../lib/proposals";
import { followUpProblem } from "../workspace/followUp";
import { answerProblem } from "../lib/answer";
import { bodyChange, markdownOf } from "./mockMarkdown";
import { planSectionOf } from "./mockPlanSection";
import { readStored, writeStored } from "../workspace/storage";
import type { Intent, ItemRef, Proposal, ProposalEdit, ProposalOrigin, ProposalQuery, ProposalsChanged, WorkItemKind, WorkstreamActor } from "../types";

/** A description update carrying a `Gossamr Plan` section that an agent run left: the plan a build follows once the person approves it. As `is_run_plan_rewrite` in `proposals.rs`. */
export const isRunPlanRewrite = (p: Proposal) => p.origin.type === "run" && p.intent.type === "rewrite" && !!p.intent.body && !!planSectionOf(p.intent.body.to);

/** Pip changed the draft's text and the person never edited it after. As `revised_by_pip_unedited` in `proposals.rs`. */
export const revisedByPipUnedited = (p: Proposal) => p.revisions.some((r) => r.note === "Revised by Pip") && !p.revisions.some((r) => r.note === "Edited");

const CONNECTION = "mock";
const SUMMARY_LIMIT = 255;
const DESCRIPTION_LIMIT = 30_000;
const RESERVED = ["<<<TICKET", "TICKET>>>", "<<<FOCUS", "FOCUS>>>", "<<<PLAN", "PLAN>>>", "<<<BUILD", "BUILD>>>", "<<<FINDINGS", "FINDINGS>>>"];

/** The backend's checks on a rewrite, in the same words. */
function rewriteProblem(i: Extract<Intent, { type: "rewrite" }>): string | null {
  if (!i.title && !i.body) return "a rewrite has to change the title or the description";
  if (i.title) {
    const to = i.title.to.trim();
    if (!to || to.includes("\n")) return "a title is one line and can't be empty";
    if ([...to].length > SUMMARY_LIMIT) return `a title is at most ${SUMMARY_LIMIT} characters`;
    if (RESERVED.some((m) => to.includes(m))) return "the title contains text Gossamr reserves; remove it";
    if (to === i.title.from.trim()) return "the new title is the same as the old one";
  }
  if (i.body) {
    const to = markdownOf(i.body.to);
    if (!to.trim()) return "a description can't be emptied; draft a comment or clear it in Jira";
    if ([...to].length > DESCRIPTION_LIMIT) return `a description is at most ${DESCRIPTION_LIMIT} characters`;
    if (RESERVED.some((m) => to.includes(m))) return "the description contains text Gossamr reserves; remove it";
    if (to === i.body.fromText) return "the new description is the same as the old one";
  }
  return null;
}

/** The backend's checks on an answer's text, in the backend's words (`check_answer` in `proposals.rs`). */
export function runAnswerProblem(message: string): string | null {
  const problem = answerProblem(message);
  if (problem) return problem;
  return RESERVED.some((m) => message.includes(m)) ? "the answer contains text Gossamr reserves; remove it" : null;
}

/** Who an audit line names for a draft's maker (`actor_of` in src-tauri/src/proposals.rs). */
export function actorOf(by: Proposal["createdBy"]): WorkstreamActor {
  switch (by) {
    case "pip":
      return "pip";
    case "agent":
      return "run";
    default:
      return "person";
  }
}

/** Drafts held in memory for the sample-data backend. `apply` performs an approved intent and returns what it created. */
export class MockProposals {
  private drafts: Proposal[] = [];
  private listeners = new Set<(c: ProposalsChanged) => void>();
  private seq = 0;

  /** Where drafts that outlive a reload are written, and which ones; set by `keep`. */
  private kept: { key: string; which: (p: Proposal) => boolean } | null = null;

  /** Every write the sample tracker made, oldest first, each with the draft the person approved for it: the only way anything reaches it. */
  readonly writes: { proposalId: string; intent: Intent }[] = [];

  /** Called with each draft that was applied, for a backend that has to tell its own listeners. */
  onApplied: (p: Proposal) => void = () => {};
  /** Told of a draft the moment its write went through, before it reads as applied, as the backend takes a workstream's basis again then. */
  onWritten: (p: Proposal) => void = () => {};

  /** Called when a draft was made, approved, skipped or retired, for the audit of its workstream; set by the backend that keeps them. */
  audit: (p: Proposal, actor: WorkstreamActor, action: string, detail?: string) => void = () => {};

  constructor(private readonly apply: (intent: Intent, already: ItemRef[]) => Promise<ItemRef[]>) {}

  /** Stores a draft the way the assistant would; `workstream` is the conversation's when it was asked in one. */
  draft(intent: Intent, label: string | null = null, requestId = "sample", workstream: string | null = null): Proposal {
    const problem = intent.type === "rewrite" ? rewriteProblem(intent) : null;
    if (problem) throw new Error(problem);
    return this.store(intent, label, workstream ? { type: "chat", requestId, workstream } : { type: "chat", requestId }, "pip");
  }

  /** Stores a draft the person made by hand. */
  create(intent: Intent, label: string | null = null): Promise<Proposal> {
    if (intent.type === "create") {
      if (!intent.fields.title.trim()) return Promise.reject(new Error("a new item needs a title"));
      if (intent.container.connectionId !== CONNECTION) return Promise.reject(new Error("that item belongs to another connection"));
    } else if (intent.type === "followUp") return Promise.reject(new Error("only Pip proposes a follow-up"));
    else if (intent.type === "runAnswer") return Promise.reject(new Error("only Pip proposes an answer; answer the run yourself from its card"));
    else if (intent.type !== "startRun" && !targetOf(intent)) return Promise.reject(new Error("a draft made by hand has to be about an existing item"));
    if (intent.type === "transition" && !intent.to.trim()) return Promise.reject(new Error("a transition needs a target status"));
    const problem = intent.type === "rewrite" ? rewriteProblem(intent) : null;
    if (problem) return Promise.reject(new Error(problem));
    return Promise.resolve(this.store(intent, label, { type: "board" }, "user"));
  }

  /** Stores a draft an agent run's result left for the person, in the run's workstream. */
  fromRun(intent: Intent, label: string | null, origin: Extract<ProposalOrigin, { type: "run" }>): Proposal {
    return this.store(intent, label, origin, "agent");
  }

  private store(intent: Intent, label: string | null, origin: ProposalOrigin, createdBy: Proposal["createdBy"]): Proposal {
    const now = new Date().toISOString();
    const p: Proposal = {
      id: `mock-${++this.seq}`,
      createdAt: now,
      updatedAt: now,
      origin,
      createdBy,
      intent,
      label,
      basis: null,
      state: { type: "pending" },
      revisions: [],
      created: [],
      error: null,
      run: null,
    };
    // Everything that can refuse the draft is decided before anything is stored, as `create` in `proposals.rs`.
    const replaced = this.tidy(p);
    this.drafts = [p, ...this.drafts.map((d) => (replaced.includes(d) ? { ...d, state: { type: "retired" as const, reason: REPLACED_REASON }, supersededBy: p.id, updatedAt: now } : d))];
    this.changed();
    this.audit(p, actorOf(createdBy), "draft_created");
    for (const old of replaced) this.audit(this.get(old.id)!, actorOf(createdBy), "draft_superseded", p.id);
    return p;
  }

  /** The older drafts `p` replaces in its workstream; throws when it would replace one the person owns, or when Pip already has the workstream's share waiting. As `tidy` in `proposals.rs`. */
  private tidy(p: Proposal): Proposal[] {
    const ws = workstreamOf(p);
    if (!ws || p.createdBy === "autopilot" || (p.createdBy === "user" && p.origin.type !== "run")) return [];
    const open = this.drafts.filter((d) => (d.state.type === "pending" || d.state.type === "applying") && workstreamOf(d) === ws);
    const replaced: Proposal[] = [];
    for (const older of open) {
      const verdict = supersession(older, p, isRunPlanRewrite);
      if (verdict.type === "refuse") throw new Error(verdict.reason);
      if (verdict.type === "supersede") replaced.push(older);
    }
    // What a run reported is never refused; Pip is told to settle what is waiting first.
    if (p.createdBy === "pip" && open.length - replaced.length >= WORKSTREAM_PENDING_CAP) throw new Error(capRefusal(ws));
    return replaced;
  }

  /** Once one move of a ticket is approved, the other pending moves of it drafted before then are retired, whoever made them. As `retire_moved_siblings` in `proposals.rs`. */
  private retireMovedSiblings(approved: Proposal) {
    if (approved.intent.type !== "transition") return;
    const on = approved.intent.item;
    const siblings = this.drafts.filter((d) => d.state.type === "pending" && d.intent.type === "transition" && d.intent.item.externalId === on.externalId && d.createdAt <= approved.updatedAt);
    for (const d of siblings) {
      const retired = this.set(d.id, { state: { type: "retired", reason: `Another move of ${on.key} was approved` } });
      this.audit(retired, "supervisor", "draft_retired");
    }
  }

  list(query: ProposalQuery = {}): Proposal[] {
    return this.drafts.filter(
      (p) =>
        (!query.states || query.states.includes(p.state.type)) &&
        (!query.item || targetOf(p.intent)?.externalId === query.item.externalId) &&
        (!query.connectionId || query.connectionId === CONNECTION) &&
        (!query.workstream || workstreamOf(p) === query.workstream),
    );
  }

  get(id: string) {
    return this.drafts.find((p) => p.id === id) ?? null;
  }

  onChanged(listener: (c: ProposalsChanged) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private pending(id: string): Proposal {
    const p = this.get(id);
    if (!p) throw new Error("that draft no longer exists");
    if (p.state.type !== "pending") throw new Error(`that draft is ${p.state.type}`);
    return p;
  }

  private set(id: string, patch: Partial<Proposal>): Proposal {
    const next = { ...this.get(id)!, ...patch, updatedAt: new Date().toISOString() };
    this.drafts = this.drafts.map((p) => (p.id === id ? next : p));
    this.changed();
    return next;
  }

  private changed() {
    if (this.kept) writeStored(this.kept.key, this.drafts.filter(this.kept.which));
    this.listeners.forEach((l) => l({ connectionId: CONNECTION }));
  }

  /**
   * Keeps the drafts `which` picks in this browser under `key`, and brings back the ones kept there before that it still
   * picks. They get new ids, after the ones this store has already given out, so they can't take one of those.
   */
  keep(key: string, which: (p: Proposal) => boolean) {
    const stored = readStored(key);
    const before = (Array.isArray(stored) ? (stored as Proposal[]) : []).filter((p) => !!p && typeof p.id === "string" && !!p.intent && !!p.state && !!p.origin && which(p));
    this.drafts = [...before.reverse().map((p) => ({ ...p, id: `mock-${++this.seq}` })).reverse(), ...this.drafts];
    this.kept = { key, which };
    this.changed();
  }

  /** The person's change to a draft, kept as an `Edited` revision as the backend keeps every edit. */
  private edited(p: Proposal, intent: Intent): Proposal {
    return this.set(p.id, { intent, revisions: [...p.revisions, { at: new Date().toISOString(), note: "Edited", intent }], error: null });
  }

  async edit(id: string, edit: ProposalEdit) {
    const p = this.pending(id);
    const { intent } = p;
    if (edit.type === "comment" && intent.type === "comment") {
      if (!edit.body.trim()) throw new Error("a comment can't be empty");
      return this.edited(p, { ...intent, body: edit.quote?.trim() ? quoteAfterFirst(docFromText(edit.body), edit.quote.trim()) : docFromText(edit.body) });
    }
    if (edit.type === "subtasks" && intent.type === "subtasks") {
      if (!edit.summaries.length || edit.summaries.some((s) => !s.trim())) throw new Error("list at least one subtask");
      return this.edited(p, { ...intent, summaries: edit.summaries });
    }
    if (edit.type === "create" && intent.type === "create") {
      if (edit.title !== undefined && !edit.title.trim()) throw new Error("a new item needs a title");
      if (edit.container && edit.container.connectionId !== CONNECTION) throw new Error("a new item can't move to another connection");
      const fields = {
        ...intent.fields,
        ...(edit.title !== undefined ? { title: edit.title.trim() } : {}),
        ...(edit.body !== undefined ? { body: docFromText(edit.body) } : {}),
        ...(edit.kind ? { kind: edit.kind } : {}),
      };
      return this.edited(p, { ...intent, container: edit.container ?? intent.container, fields });
    }
    if (edit.type === "rewrite" && intent.type === "rewrite") {
      if ((edit.title !== undefined && !intent.title) || (edit.body !== undefined && !intent.body)) throw new Error(`this draft doesn't change the ${edit.title !== undefined ? "title" : "description"}`);
      const next: Intent = {
        ...intent,
        title: intent.title && edit.title !== undefined ? { ...intent.title, to: edit.title.split(/\s+/).filter(Boolean).join(" ") } : intent.title,
        body: intent.body && edit.body !== undefined ? bodyChange(intent.body.from, edit.body.trim()) : intent.body,
      };
      const problem = rewriteProblem(next as Extract<Intent, { type: "rewrite" }>);
      if (problem) throw new Error(problem);
      return this.set(id, { intent: next, revisions: [...p.revisions, { at: new Date().toISOString(), note: "Edited", intent: next }], error: null });
    }
    if (edit.type === "followUp" && intent.type === "followUp") {
      const problem = followUpProblem(edit.message);
      if (problem) throw new Error(problem);
      const next: Intent = { ...intent, message: edit.message.trim() };
      return this.set(id, { intent: next, revisions: [...p.revisions, { at: new Date().toISOString(), note: "Edited", intent: next }], error: null });
    }
    if (edit.type === "runAnswer" && intent.type === "runAnswer") {
      const problem = runAnswerProblem(edit.message);
      if (problem) throw new Error(problem);
      return this.edited(p, { ...intent, message: edit.message.trim() });
    }
    if (edit.type === "run" && intent.type === "startRun") {
      if (edit.instruction !== undefined && !edit.instruction.trim()) throw new Error("the instruction can't be empty");
      const { instruction, base, clonePath, kind, name, pr, allowPush, report, plan, buildAccount, project } = edit;
      if (project && project.connectionId !== CONNECTION) throw new Error("the project belongs to another connection");
      const was = intent.spec;
      const switched = kind && kind !== was.kind;
      const untouched = instruction === undefined && was.instruction.trim() === INSTRUCTIONS[was.kind];
      const spec = {
        ...was,
        ...(instruction !== undefined ? { instruction } : {}),
        ...(base !== undefined ? { base: base.trim() } : {}),
        ...(clonePath !== undefined ? { clonePath } : {}),
        ...(kind ? { kind } : {}),
        // A review always reports its verdict; what another kind asks for is the person's choice again.
        ...(switched ? { pr: null, prSha: null, allowPush: kind === "build", report: kind === "review" ? true : was.kind === "review" ? false : was.report, ...(kind !== "build" ? { plan: null, planFromRun: null, planApproved: false } : {}), ...(kind !== "review" ? { buildAccount: null, buildFromRun: null } : {}), ...(kind !== "triage" && kind !== "plan" ? { findings: null, findingsFromRun: null } : {}), ...(untouched ? { instruction: INSTRUCTIONS[kind] } : {}), ...(kind !== "investigate" ? { project: null } : {}) } : {}),
        ...(project ? { project } : {}),
        ...(pr !== undefined ? { pr, prSha: null, ...(pr !== was.pr ? { buildAccount: null, buildFromRun: null } : {}) } : {}),
        ...(allowPush !== undefined ? { allowPush } : {}),
        ...(report !== undefined ? { report } : {}),
        // Plan text the person changed here is theirs, so the build is told a person settled it.
        ...(plan !== undefined ? (plan.trim() ? { plan, planApproved: !!was.planApproved || plan !== was.plan } : { plan: null, planFromRun: null, planApproved: false }) : {}),
        ...(buildAccount !== undefined ? (buildAccount.trim() ? { buildAccount } : { buildAccount: null, buildFromRun: null }) : {}),
        ...(name !== undefined ? { name: name.trim() } : {}),
      };
      if (report === false && spec.kind === "review") throw new Error(REVIEW_REPORTS);
      if (spec.allowPush && spec.kind !== "build") throw new Error("Only a build can push.");
      if (allowPush === false && spec.kind === "build" && spec.workstream) throw new Error("a workstream's build always publishes a draft pull request");
      if (plan?.trim() && !was.planFromRun) throw new Error("this draft doesn't carry a plan");
      if (buildAccount?.trim() && !was.buildFromRun) throw new Error("this draft doesn't carry a builder's account");
      if (buildAccount && [...buildAccount].length > BUILD_ACCOUNT_LIMIT) throw new Error(`The builder's account must be text of at most ${BUILD_ACCOUNT_LIMIT} characters.`);
      if (plan && [...plan].length > PLAN_LIMIT) throw new Error(`The plan must be text of at most ${PLAN_LIMIT} characters.`);
      return this.set(id, { intent: { ...intent, spec }, error: null });
    }
    throw new Error("that edit doesn't fit this draft");
  }

  /** Pip's change to the text of its own pending comment, or of the pending comment, new ticket or breakdown an agent run left for the person. A ticket may change its title and type too, its project never; a breakdown only its summaries. A draft of a workstream is revised only from that workstream's conversation (`workstream`). */
  pipRevise(id: string, change: string | { body?: string; title?: string; description?: string; kind?: WorkItemKind; summaries?: string[] }, workstream: string | null = null): Proposal {
    const { body, title, description, kind, summaries } = typeof change === "string" ? { body: change, title: undefined, description: undefined, kind: undefined, summaries: undefined } : change;
    const p = this.pending(id);
    const ownWorkstream = () => {
      const of = workstreamOf(p);
      if (of !== null && of !== workstream) throw new Error("that draft belongs to another workstream");
    };
    if (p.intent.type === "rewrite") {
      if (p.revisions.some((r) => r.note === "Edited")) throw new Error("the user edited this description draft, so Pip can't change it any more");
      // A build follows the plan the person approves here and is told a person settled it, so none of it may be Pip's.
      if (leftByRun(p) && isRunPlanRewrite(p)) throw new Error(PLAN_IS_THE_USERS);
      if (p.createdBy !== "pip" && !leftByRun(p)) throw new Error("that draft wasn't made by Pip or from an agent run's result, so Pip can't change it");
      ownWorkstream();
      const was = p.intent;
      if ((title !== undefined && !was.title) || (description !== undefined && !was.body)) throw new Error("this draft doesn't change that field; retire it and propose a new one");
      const intent: Intent = {
        ...was,
        title: was.title && title !== undefined ? { ...was.title, to: title.split(/\s+/).filter(Boolean).join(" ") } : was.title,
        body: was.body && description !== undefined ? bodyChange(was.body.from, description.trim()) : was.body,
      };
      const problem = rewriteProblem(intent as Extract<Intent, { type: "rewrite" }>);
      if (problem) throw new Error(problem);
      return this.set(id, { intent, revisions: [...p.revisions, { at: new Date().toISOString(), note: "Revised by Pip", intent }], error: null });
    }
    if (p.intent.type === "runAnswer") {
      if (p.revisions.some((r) => r.note === "Edited")) throw new Error("the user edited this answer, so Pip can't change it any more");
      if (p.createdBy !== "pip") throw new Error("that draft wasn't made by Pip, so Pip can't change it");
      ownWorkstream();
      const problem = runAnswerProblem(body ?? "");
      if (problem) throw new Error(problem);
      const intent: Intent = { ...p.intent, message: (body ?? "").trim() };
      return this.set(id, { intent, revisions: [...p.revisions, { at: new Date().toISOString(), note: "Revised by Pip", intent }], error: null });
    }
    if (p.intent.type === "followUp") {
      if (p.revisions.some((r) => r.note === "Edited")) throw new Error("the user edited this follow-up, so Pip can't change it any more");
      if (p.createdBy !== "pip") throw new Error("that draft wasn't made by Pip, so Pip can't change it");
      ownWorkstream();
      const problem = followUpProblem(body ?? "");
      if (problem) throw new Error(problem);
      const intent: Intent = { ...p.intent, message: (body ?? "").trim() };
      return this.set(id, { intent, revisions: [...p.revisions, { at: new Date().toISOString(), note: "Revised by Pip", intent }], error: null });
    }
    const left = leftByRun(p) && (p.intent.type === "comment" || p.intent.type === "create" || p.intent.type === "subtasks");
    // Person edits are final: what an agent left is the person's once they have edited it.
    if (left && p.revisions.some((r) => r.note === "Edited")) throw new Error("the user edited this draft, so Pip can't change it any more");
    if (p.createdBy !== "pip" && !left) throw new Error("that draft wasn't made by Pip or from an agent run's result, so Pip can't change it");
    ownWorkstream();
    let intent: Intent;
    if (p.intent.type === "comment") intent = { ...p.intent, body: docFromText(body ?? docText(p.intent.body)) };
    else if (p.intent.type === "create") {
      const fields = p.intent.fields;
      intent = { ...p.intent, fields: { ...fields, title: title?.trim() || fields.title, body: body === undefined ? fields.body : docFromText(body), kind: kind ?? fields.kind } };
    } else if (p.intent.type === "subtasks") {
      const next = (summaries ?? p.intent.summaries).map((s) => s.trim()).filter(Boolean);
      if (!next.length) throw new Error("list at least one subtask, and none of them blank");
      intent = { ...p.intent, summaries: next };
    } else throw new Error("this kind of draft can't be revised");
    return this.set(id, { intent, revisions: [...p.revisions, { at: new Date().toISOString(), note: "Revised by Pip", intent }], error: null });
  }

  /** Withdraws a waiting draft that a newer one replaces. */
  retire(id: string, reason: string): Proposal {
    this.pending(id);
    return this.set(id, { state: { type: "retired", reason } });
  }

  async skip(id: string) {
    const p = this.get(id);
    if (p?.state.type === "skipped") return p;
    this.pending(id);
    const skipped = this.set(id, { state: { type: "skipped" } });
    this.audit(skipped, "person", "draft_skipped");
    return skipped;
  }

  /** A pending build draft's plan read again from its run, for `MockRuns.refreshPlan`: the text and whether it was settled, both replaced. */
  readPlanAgain(id: string, carried: { plan: string; planApproved: boolean }): Proposal {
    const p = this.pending(id);
    if (p.intent.type !== "startRun") throw new Error("that draft doesn't start a run");
    return this.set(id, { intent: { ...p.intent, spec: { ...p.intent.spec, ...carried } }, error: null });
  }

  /** Marks a run draft applied, for `MockRuns.approve`. */
  applyRun(id: string, runId: string): Proposal {
    this.pending(id);
    return this.set(id, { state: { type: "applied" }, run: runId, error: null });
  }

  /** Marks an answer draft sent with the text that went, kept as the person's revision when it differs, as `answer_draft_sent`. */
  answerSent(id: string, runId: string, sent: string): Proposal {
    const p = this.pending(id);
    if (p.intent.type !== "runAnswer") throw new Error("that draft isn't an answer");
    const changed = p.intent.message.trim() !== sent.trim();
    const intent: Intent = changed ? { ...p.intent, message: sent.trim() } : p.intent;
    const revisions = changed ? [...p.revisions, { at: new Date().toISOString(), note: "Edited", intent }] : p.revisions;
    return this.set(id, { intent, revisions, state: { type: "applied" }, run: runId, error: null });
  }

  /** Keeps a pending draft with the reason sending it failed. */
  failed(id: string, why: string) {
    if (this.get(id)?.state.type === "pending") this.set(id, { error: why });
  }

  async approve(id: string) {
    const p = this.pending(id);
    if (p.intent.type === "startRun") throw new Error("A run is approved with its own button");
    if (p.intent.type === "followUp") throw new Error("A follow-up is sent back with its own button");
    if (p.intent.type === "runAnswer") throw new Error("An answer is sent with its own button");
    this.set(id, { state: { type: "applying" } });
    try {
      const created = await this.apply(p.intent, p.created);
      this.writes.push({ proposalId: id, intent: p.intent });
      this.onWritten(p);
      const applied = this.set(id, { state: { type: "applied" }, created: [...p.created, ...created], error: null });
      this.onApplied(applied);
      this.audit(applied, "person", "draft_approved");
      this.retireMovedSiblings(applied);
      return applied;
    } catch (e) {
      return this.set(id, { state: { type: "pending" }, error: String(e) });
    }
  }
}
