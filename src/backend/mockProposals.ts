import { docFromText, quoteAfterFirst } from "../lib/docs";
import { INSTRUCTIONS } from "./mockRunKinds";
import { targetOf } from "../lib/proposals";
import type { Intent, ItemRef, Proposal, ProposalEdit, ProposalOrigin, ProposalQuery, ProposalsChanged } from "../types";

const CONNECTION = "mock";

/** Drafts held in memory for the sample-data backend. `apply` performs an approved intent and returns what it created. */
export class MockProposals {
  private drafts: Proposal[] = [];
  private listeners = new Set<(c: ProposalsChanged) => void>();
  private seq = 0;

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
      const { instruction, base, clonePath, kind, name, pr, allowPush } = edit;
      const was = intent.spec;
      const switched = kind && kind !== was.kind;
      const untouched = instruction === undefined && was.instruction.trim() === INSTRUCTIONS[was.kind];
      const spec = {
        ...was,
        ...(instruction !== undefined ? { instruction } : {}),
        ...(base !== undefined ? { base: base.trim() } : {}),
        ...(clonePath !== undefined ? { clonePath } : {}),
        ...(kind ? { kind } : {}),
        ...(switched ? { pr: null, prSha: null, allowPush: false, ...(untouched ? { instruction: INSTRUCTIONS[kind] } : {}) } : {}),
        ...(pr !== undefined ? { pr, prSha: null } : {}),
        ...(allowPush !== undefined ? { allowPush } : {}),
        ...(name !== undefined ? { name: name.trim() } : {}),
      };
      if (spec.allowPush && spec.kind !== "build") throw new Error("Only a build can push.");
      return this.set(id, { intent: { ...intent, spec }, error: null });
    }
    throw new Error("that edit doesn't fit this draft");
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
      return this.set(id, { state: { type: "applied" }, created: [...p.created, ...created], error: null });
    } catch (e) {
      return this.set(id, { state: { type: "pending" }, error: String(e) });
    }
  }
}
