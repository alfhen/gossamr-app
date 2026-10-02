import { docFromText, docText, quoteAfterFirst } from "../lib/docs";
import { INSTRUCTIONS, PLAN_LIMIT } from "./mockRunKinds";
import { targetOf } from "../lib/proposals";
import type { Intent, ItemRef, Proposal, ProposalEdit, ProposalOrigin, ProposalQuery, ProposalsChanged, WorkItemKind } from "../types";

const CONNECTION = "mock";

/** Drafts held in memory for the sample-data backend. `apply` performs an approved intent and returns what it created. */
export class MockProposals {
  private drafts: Proposal[] = [];
  private listeners = new Set<(c: ProposalsChanged) => void>();
  private seq = 0;

  /** Called with each draft that was applied, for a backend that has to tell its own listeners. */
  onApplied: (p: Proposal) => void = () => {};

  constructor(private readonly apply: (intent: Intent, already: ItemRef[]) => Promise<ItemRef[]>) {}

  /** Stores a draft the way the assistant would. */
  draft(intent: Intent, label: string | null = null, requestId = "sample"): Proposal {
    return this.store(intent, label, { type: "chat", requestId }, "pip");
  }

  /** Stores a draft the person made by hand. */
  create(intent: Intent, label: string | null = null): Promise<Proposal> {
    if (intent.type === "create") {
      if (!intent.fields.title.trim()) return Promise.reject(new Error("a new item needs a title"));
      if (intent.container.connectionId !== CONNECTION) return Promise.reject(new Error("that item belongs to another connection"));
    } else if (intent.type !== "startRun" && !targetOf(intent)) return Promise.reject(new Error("a draft made by hand has to be about an existing item"));
    if (intent.type === "transition" && !intent.to.trim()) return Promise.reject(new Error("a transition needs a target status"));
    return Promise.resolve(this.store(intent, label, { type: "board" }, "user"));
  }

  /** Stores a draft the person made from an agent run's result. */
  fromRun(intent: Intent, label: string | null, origin: Extract<ProposalOrigin, { type: "run" }>): Proposal {
    return this.store(intent, label, origin, "user");
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
    this.drafts = [p, ...this.drafts];
    this.changed();
    return p;
  }

  list(query: ProposalQuery = {}): Proposal[] {
    return this.drafts.filter(
      (p) =>
        (!query.states || query.states.includes(p.state.type)) &&
        (!query.item || targetOf(p.intent)?.externalId === query.item.externalId) &&
        (!query.connectionId || query.connectionId === CONNECTION),
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
    this.listeners.forEach((l) => l({ connectionId: CONNECTION }));
  }

  async edit(id: string, edit: ProposalEdit) {
    const { intent } = this.pending(id);
    if (edit.type === "comment" && intent.type === "comment") {
      if (!edit.body.trim()) throw new Error("a comment can't be empty");
      return this.set(id, { intent: { ...intent, body: edit.quote?.trim() ? quoteAfterFirst(docFromText(edit.body), edit.quote.trim()) : docFromText(edit.body) }, error: null });
    }
    if (edit.type === "subtasks" && intent.type === "subtasks") {
      if (!edit.summaries.length || edit.summaries.some((s) => !s.trim())) throw new Error("list at least one subtask");
      return this.set(id, { intent: { ...intent, summaries: edit.summaries }, error: null });
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
      return this.set(id, { intent: { ...intent, container: edit.container ?? intent.container, fields }, error: null });
    }
    if (edit.type === "run" && intent.type === "startRun") {
      if (edit.instruction !== undefined && !edit.instruction.trim()) throw new Error("the instruction can't be empty");
      const { instruction, base, clonePath, kind, name, pr, allowPush, plan, project } = edit;
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
        ...(switched ? { pr: null, prSha: null, allowPush: false, ...(kind !== "build" ? { plan: null, planFromRun: null } : {}), ...(untouched ? { instruction: INSTRUCTIONS[kind] } : {}), ...(kind !== "investigate" ? { project: null } : {}) } : {}),
        ...(project ? { project } : {}),
        ...(pr !== undefined ? { pr, prSha: null } : {}),
        ...(allowPush !== undefined ? { allowPush } : {}),
        ...(plan !== undefined ? (plan.trim() ? { plan } : { plan: null, planFromRun: null }) : {}),
        ...(name !== undefined ? { name: name.trim() } : {}),
      };
      if (spec.allowPush && spec.kind !== "build") throw new Error("Only a build can push.");
      if (plan?.trim() && !was.planFromRun) throw new Error("this draft doesn't carry a plan");
      if (plan && [...plan].length > PLAN_LIMIT) throw new Error(`The plan must be text of at most ${PLAN_LIMIT} characters.`);
      return this.set(id, { intent: { ...intent, spec }, error: null });
    }
    throw new Error("that edit doesn't fit this draft");
  }

  /** Pip's change to the text of its own pending comment, or of the pending comment, new ticket or breakdown an agent run left for the person. A ticket may change its title and type too, its project never; a breakdown only its summaries. */
  pipRevise(id: string, change: string | { body?: string; title?: string; kind?: WorkItemKind; summaries?: string[] }): Proposal {
    const { body, title, kind, summaries } = typeof change === "string" ? { body: change, title: undefined, kind: undefined, summaries: undefined } : change;
    const p = this.pending(id);
    const left = p.origin.type === "run" && (p.intent.type === "comment" || p.intent.type === "create" || p.intent.type === "subtasks") && p.createdBy === "user";
    if (p.createdBy !== "pip" && !left) throw new Error("that draft wasn't made by Pip or from an agent run's result, so Pip can't change it");
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

  async skip(id: string) {
    const p = this.get(id);
    if (p?.state.type === "skipped") return p;
    this.pending(id);
    return this.set(id, { state: { type: "skipped" } });
  }

  /** Marks a run draft applied, for `MockRuns.approve`. */
  applyRun(id: string, runId: string): Proposal {
    this.pending(id);
    return this.set(id, { state: { type: "applied" }, run: runId, error: null });
  }

  async approve(id: string) {
    const p = this.pending(id);
    if (p.intent.type === "startRun") throw new Error("A run is approved with its own button");
    this.set(id, { state: { type: "applying" } });
    try {
      const created = await this.apply(p.intent, p.created);
      const applied = this.set(id, { state: { type: "applied" }, created: [...p.created, ...created], error: null });
      this.onApplied(applied);
      return applied;
    } catch (e) {
      return this.set(id, { state: { type: "pending" }, error: String(e) });
    }
  }
}
