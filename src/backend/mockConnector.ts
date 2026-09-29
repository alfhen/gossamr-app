import { docFromText } from "../lib/docs";
import { compileFilter, itemKey, type FilterContext } from "../lib/filter";
import { canMove, statusOf } from "../lib/workflow";
import type {
  ContainerRef,
  ItemRef,
  Person,
  PersonRef,
  StatusDef,
  WorkCategory,
  WorkContainer,
  WorkEvent,
  WorkFilter,
  WorkItem,
  WorkItemKind,
  WorkLink,
  WorkPriority,
  Workflow,
} from "../types";

export const MOCK_CONNECTION = "mock";

export const PEOPLE = {
  me: "Alf Henderson",
  sam: "Sam Holt",
  mette: "Mette Lund",
  jonas: "Jonas Berg",
  priya: "Priya Nair",
  ida: "Ida Pedersen",
  byron: "Byron Fichardt",
  maya: "Maya Lindqvist",
  klara: "Klara Nyberg",
} as const;
type PersonId = keyof typeof PEOPLE;

export const itemRef = (key: string): ItemRef => ({ connectionId: MOCK_CONNECTION, externalId: key, key });
export const personRef = (accountId: string): PersonRef => ({ connectionId: MOCK_CONNECTION, accountId });
export const containerRef = (key: string): ContainerRef => ({ connectionId: MOCK_CONNECTION, externalId: key });
const projectOf = (key: string) => key.split("-")[0];

type Statuses = [name: string, category: WorkCategory][];

interface Project {
  key: string;
  name: string;
  statuses: Statuses;
  /** Allowed moves by status name; omitted means any status can move to any other. */
  moves?: Record<string, string[]>;
}

const PROJECTS: Project[] = [
  {
    key: "DEVOPS",
    name: "DevOps",
    statuses: [["To Do", "todo"], ["In Progress", "active"], ["In Review", "active"], ["Blocked", "active"], ["Done", "done"]],
    moves: {
      "To Do": ["In Progress"],
      "In Progress": ["To Do", "In Review", "Blocked"],
      "In Review": ["In Progress", "Blocked", "Done"],
      Blocked: ["In Progress"],
      Done: ["In Progress"],
    },
  },
  {
    key: "CA",
    name: "Campaigns",
    statuses: [["Backlog", "todo"], ["Copy", "active"], ["Design", "active"], ["QA", "active"], ["Scheduled", "active"], ["Sent", "done"]],
    moves: { Backlog: ["Copy"], Copy: ["Backlog", "Design"], Design: ["Copy", "QA"], QA: ["Design", "Scheduled"], Scheduled: ["QA", "Sent"], Sent: [] },
  },
  {
    key: "WEB",
    name: "Webshop",
    statuses: [["To Do", "todo"], ["In Progress", "active"], ["Code review", "active"], ["Testing", "active"], ["Released", "done"]],
    moves: {
      "To Do": ["In Progress"],
      "In Progress": ["To Do", "Code review"],
      "Code review": ["In Progress", "Testing"],
      Testing: ["Code review", "Released"],
      Released: [],
    },
  },
  {
    key: "SUP",
    name: "Support",
    statuses: [["New", "todo"], ["Investigating", "active"], ["Waiting on customer", "active"], ["Resolved", "done"]],
  },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
export const statusId = (project: string, name: string) => `${project.toLowerCase()}-${slug(name)}`;

function workflowOf(p: Project): Workflow {
  const statuses: StatusDef[] = p.statuses.map(([name, category]) => ({ id: statusId(p.key, name), name, category }));
  if (!p.moves) return { statuses, transitions: { kind: "any" } };
  const moves = Object.entries(p.moves).flatMap(([from, tos]) => tos.map((to) => ({ from: statusId(p.key, from), to: statusId(p.key, to) })));
  return { statuses, transitions: { kind: "graph", moves } };
}

interface Row {
  key: string;
  kind: WorkItemKind;
  title: string;
  status: string;
  assignee?: PersonId;
  parent?: string;
  age: number;
  labels?: string[];
  priority?: WorkPriority;
  body?: string;
}

const row = (
  key: string,
  kind: WorkItemKind,
  title: string,
  status: string,
  assignee: PersonId | undefined,
  age: number,
  more: Partial<Row> = {},
): Row => ({ key, kind, title, status, assignee, age, ...more });

/** `age` is days since the last update, so the mix of fresh, aging and stale items stays put as the clock moves. */
const ROWS: Row[] = [
  row("DEVOPS-470", "epic", "Checkout resilience", "In Progress", "mette", 2, { priority: "high", body: "Payments must survive a partial outage of any single provider." }),
  row("DEVOPS-480", "epic", "Shopify event pipeline", "In Progress", "mette", 4, { body: "Every store event reaches the warehouse exactly once." }),
  row("DEVOPS-471", "story", "Retry failed payment webhooks", "In Review", "me", 1, { parent: "DEVOPS-470", labels: ["payments"], priority: "high", body: "Retries back off and cap at five attempts." }),
  row("DEVOPS-472", "task", "Add dead-letter queue for webhooks", "In Progress", "sam", 6, { parent: "DEVOPS-470", labels: ["queue"] }),
  row("DEVOPS-473", "bug", "Duplicate order events on retry", "Blocked", "jonas", 9, { parent: "DEVOPS-480", labels: ["bug"], priority: "high", body: "A retried delivery emits the order event twice." }),
  row("DEVOPS-474", "task", "Dashboard for event lag", "To Do", undefined, 3, { parent: "DEVOPS-480" }),
  row("DEVOPS-475", "task", "Rotate API keys", "To Do", "me", 12, { labels: ["security"] }),
  row("DEVOPS-476", "task", "Add Sentry release tags to worker deploys", "To Do", undefined, 2, { body: "Tag every deploy so a regression traces to a commit." }),
  row("DEVOPS-477", "bug", "Worker runs out of memory on large campaigns", "In Progress", "priya", 4, { labels: ["bug"], priority: "highest" }),
  row("DEVOPS-478", "task", "Upgrade queue library", "Done", "sam", 8),
  row("DEVOPS-479", "task", "Document alert thresholds", "To Do", "maya", 20, { priority: "low" }),
  row("DEVOPS-490", "story", "Backfill missing events", "In Progress", "me", 0, { parent: "DEVOPS-480", priority: "high" }),
  row("DEVOPS-491", "task", "Idempotency keys for consumers", "To Do", "byron", 5, { parent: "DEVOPS-480" }),
  row("DEVOPS-492", "task", "Runbook for event replay", "Done", "maya", 15, { parent: "DEVOPS-480" }),
  row("DEVOPS-493", "bug", "Replay skips dead-lettered events", "In Review", "sam", 1, { parent: "DEVOPS-480", labels: ["bug"] }),
  row("CA-400", "epic", "Autumn campaign", "Copy", "mette", 1, { priority: "high" }),
  row("CA-401", "story", "Welcome flow refresh", "Design", "maya", 2, { parent: "CA-400", labels: ["flow"] }),
  row("CA-402", "task", "Subject line variants", "Copy", "me", 3, { parent: "CA-400" }),
  row("CA-403", "task", "Hero banner", "Design", "ida", 6, { parent: "CA-400" }),
  row("CA-404", "task", "Segment for lapsed customers", "QA", "ida", 4, { parent: "CA-400", body: "Needs the sign-up form before the segment can be tested." }),
  row("CA-405", "bug", "Duplicate back-in-stock emails", "Backlog", undefined, 2, { labels: ["bug"], body: "Two customers got the same email once per address." }),
  row("CA-406", "task", "Translate footer", "Scheduled", "byron", 1, { parent: "CA-400" }),
  row("CA-407", "task", "Send-time test", "Sent", "maya", 11),
  row("CA-408", "story", "Winback flow", "Backlog", undefined, 14),
  row("CA-409", "task", "Unsubscribe page copy", "Copy", "me", 8, { labels: ["copy"] }),
  row("WEB-100", "epic", "Product page speed", "In Progress", "sam", 2),
  row("WEB-101", "task", "Lazy-load swatch images", "Code review", "me", 1, { parent: "WEB-100", labels: ["frontend"] }),
  row("WEB-102", "story", "Back-in-stock sign-up form", "In Progress", "priya", 3, { labels: ["frontend"] }),
  row("WEB-103", "task", "Preload hero font", "Testing", "byron", 2, { parent: "WEB-100" }),
  row("WEB-104", "task", "Fix layout shift on swatches", "To Do", undefined, 5, { parent: "WEB-100", body: "Swatches load after the image and push the title down." }),
  row("WEB-105", "bug", "Swatch labels are cut off on small phones", "To Do", undefined, 1, { labels: ["bug", "mobile"] }),
  row("WEB-106", "bug", "Cart badge is off by one", "Released", "ida", 9, { labels: ["bug"] }),
  row("WEB-107", "task", "Update image CDN config", "To Do", "jonas", 13),
  row("WEB-108", "story", "Size guide modal", "In Progress", "me", 7, { labels: ["frontend"] }),
  row("SUP-10", "task", "Customer can't apply discount code", "Investigating", "klara", 1),
  row("SUP-11", "bug", "Order confirmation email is missing", "New", undefined, 0, { labels: ["bug"] }),
  row("SUP-12", "task", "Refund stuck in pending", "Waiting on customer", "me", 4),
  row("SUP-13", "task", "Change delivery address", "Resolved", "klara", 3),
  row("SUP-14", "bug", "Tracking link gives a 404", "Investigating", "byron", 10, { labels: ["bug"] }),
  row("SUP-15", "task", "Wholesale account request", "New", undefined, 6),
];

const LINKS: [string, string, WorkLink["kind"]][] = [
  ["DEVOPS-472", "DEVOPS-471", "blocks"],
  ["DEVOPS-490", "DEVOPS-473", "blocks"],
  ["DEVOPS-478", "DEVOPS-472", "blocks"],
  ["WEB-102", "CA-404", "blocks"],
  ["DEVOPS-490", "DEVOPS-491", "relates"],
  ["DEVOPS-493", "DEVOPS-473", "relates"],
  ["WEB-101", "WEB-104", "relates"],
  ["SUP-11", "DEVOPS-473", "relates"],
];

/** Items waiting on the user: a review asked for, a mention, a customer reply. */
const NEEDS_ME = ["DEVOPS-471", "CA-409", "WEB-101", "SUP-12"];

const COMMENTS: [key: string, author: PersonId, minutesAgo: number, text: string][] = [
  ["DEVOPS-471", "sam", 90, "Ready for another look, retries now cap at five."],
  ["DEVOPS-472", "sam", 60 * 24 * 5, "Queue is provisioned in staging."],
  ["DEVOPS-473", "jonas", 60 * 24 * 2, "Waiting on the backfill before I can reproduce this."],
  ["CA-404", "ida", 60 * 24 * 3, "Can't test the segment until the sign-up form ships."],
  ["CA-409", "mette", 300, "@Alf Henderson can you check the legal wording?"],
  ["WEB-101", "priya", 45, "Swatches flicker on Safari, could you take a look?"],
  ["WEB-102", "priya", 60 * 24, "Form is validated, waiting on the copy."],
  ["SUP-12", "klara", 20, "The customer replied with their bank reference."],
];

const CHANGES: [key: string, actor: PersonId, minutesAgo: number, from: string, to: string][] = [
  ["DEVOPS-471", "me", 60 * 26, "In Progress", "In Review"],
  ["DEVOPS-473", "jonas", 60 * 24 * 9, "In Progress", "Blocked"],
  ["CA-406", "byron", 60 * 20, "QA", "Scheduled"],
  ["WEB-106", "ida", 60 * 24 * 9, "Testing", "Released"],
];

const PRIORITY_FALLBACK: WorkPriority = "medium";

export type Change = { connectionId: string };

/** A tracker held in memory: several projects, each with its own workflow, and the events around their items. */
export class MockConnector {
  readonly connectionId = MOCK_CONNECTION;
  readonly me = personRef("me");
  readonly people: Person[] = Object.entries(PEOPLE).map(([accountId, name]) => ({ accountId, name }));
  private items = new Map<string, WorkItem>();
  private events = new Map<string, WorkEvent[]>();
  private containers: WorkContainer[];
  private needsMe: Set<string>;
  private seq = 0;
  private nextNumber: Record<string, number> = {};

  constructor(
    private readonly now: number = Date.now(),
    private readonly onChange: (c: Change) => void = () => {},
  ) {
    this.containers = PROJECTS.map((p) => ({ ref: containerRef(p.key), key: p.key, name: p.name, workflow: workflowOf(p) }));
    const at = (minutes: number) => new Date(this.now - minutes * 60_000).toISOString();
    const statusIn = (project: string, name: string) => this.containers.find((c) => c.key === project)!.workflow.statuses.find((s) => s.name === name)!;

    for (const r of ROWS) {
      const project = projectOf(r.key);
      const updated = at(r.age * 24 * 60);
      this.items.set(r.key, {
        item: itemRef(r.key),
        container: containerRef(project),
        kind: r.kind,
        title: r.title,
        body: r.body ? docFromText(r.body) : { blocks: [] },
        status: statusIn(project, r.status),
        assignee: r.assignee ? personRef(r.assignee) : null,
        reporter: personRef("mette"),
        priority: r.priority ?? PRIORITY_FALLBACK,
        parent: r.parent ? itemRef(r.parent) : null,
        labels: r.labels ?? [],
        created: at((r.age + 30) * 24 * 60),
        updated,
        links: [],
        commentCount: 0,
        lastCommenter: null,
        extra: null,
      });
      this.nextNumber[project] = Math.max(this.nextNumber[project] ?? 0, Number(r.key.split("-")[1]) + 1);
      this.record(r.key, "itemCreated", "mette", at((r.age + 30) * 24 * 60), null);
    }
    for (const [from, to, kind] of LINKS) {
      const item = this.items.get(from)!;
      item.links = [...item.links, { from: itemRef(from), to: itemRef(to), kind }];
    }
    for (const [key, author, minutes, text] of COMMENTS) {
      this.record(key, "commentAdded", author, at(minutes), { text });
      const item = this.items.get(key)!;
      item.commentCount += 1;
      item.lastCommenter = personRef(author);
    }
    for (const [key, actor, minutes, from, to] of CHANGES) this.record(key, "statusChanged", actor, at(minutes), { from, to });
    this.needsMe = new Set(NEEDS_ME.map((k) => itemKey(itemRef(k))));
  }

  private record(key: string, kind: WorkEvent["kind"], actor: string | null, at: string, payload: unknown) {
    const event: WorkEvent = {
      id: `mock-event-${++this.seq}`,
      connectionId: MOCK_CONNECTION,
      at,
      kind,
      subject: { type: "item", item: itemRef(key) },
      actor: actor ? personRef(actor) : null,
      payload,
    };
    this.events.set(key, [event, ...(this.events.get(key) ?? [])].sort((a, b) => b.at.localeCompare(a.at)));
  }

  private get ctx(): FilterContext {
    return { me: [this.me], now: this.now, needsMe: this.needsMe };
  }

  has(ref: ItemRef) {
    return ref.connectionId === MOCK_CONNECTION && this.items.has(ref.externalId);
  }

  /** Items that match, newest first. */
  search(filter: WorkFilter): WorkItem[] {
    const all = [...this.items.values()];
    return all.filter(compileFilter(filter, all, this.ctx)).sort((a, b) => b.updated.localeCompare(a.updated));
  }

  item(ref: ItemRef): WorkItem | null {
    return ref.connectionId === MOCK_CONNECTION ? (this.items.get(ref.externalId) ?? null) : null;
  }

  listContainers(): WorkContainer[] {
    return this.containers;
  }

  workflow(c: ContainerRef): Workflow | null {
    return this.containers.find((x) => x.ref.externalId === c.externalId && c.connectionId === MOCK_CONNECTION)?.workflow ?? null;
  }

  eventsFor(ref: ItemRef): WorkEvent[] {
    return this.has(ref) ? (this.events.get(ref.externalId) ?? []) : [];
  }

  /** Moves an item along its project's workflow; a move the workflow doesn't allow is refused. */
  transition(ref: ItemRef, toStatusId: string) {
    const item = this.item(ref);
    if (!item) throw new Error(`${ref.key} isn't in the sample data`);
    const wf = this.workflow(item.container)!;
    const to = statusOf(wf, toStatusId);
    if (!to) throw new Error(`${item.container.externalId} has no such status`);
    if (!canMove(wf, item.status.id, to.id)) throw new Error(`${ref.key} can't move from ${item.status.name} to ${to.name}`);
    const at = new Date().toISOString();
    this.items.set(ref.externalId, { ...item, status: to, updated: at });
    this.record(ref.externalId, "statusChanged", "me", at, { from: item.status.name, to: to.name });
    this.onChange({ connectionId: MOCK_CONNECTION });
  }

  comment(ref: ItemRef, text: string) {
    const item = this.item(ref);
    if (!item) throw new Error(`${ref.key} isn't in the sample data`);
    const at = new Date().toISOString();
    this.items.set(ref.externalId, { ...item, commentCount: item.commentCount + 1, lastCommenter: this.me, updated: at });
    this.record(ref.externalId, "commentAdded", "me", at, { text });
    this.onChange({ connectionId: MOCK_CONNECTION });
  }

  /** Creates tasks under `parent`, in the first status of its project. */
  createSubtasks(parent: ItemRef, summaries: string[]): ItemRef[] {
    const p = this.item(parent);
    if (!p) throw new Error(`${parent.key} isn't in the sample data`);
    const project = p.container.externalId;
    const first = this.workflow(p.container)!.statuses[0];
    const at = new Date().toISOString();
    const created = summaries.map((title) => {
      const key = `${project}-${this.nextNumber[project]++}`;
      this.items.set(key, {
        ...p,
        item: itemRef(key),
        kind: "task",
        title,
        body: { blocks: [] },
        status: first,
        assignee: null,
        parent: parent,
        labels: [],
        created: at,
        updated: at,
        links: [],
        commentCount: 0,
        lastCommenter: null,
      });
      this.record(key, "itemCreated", "me", at, null);
      return itemRef(key);
    });
    this.onChange({ connectionId: MOCK_CONNECTION });
    return created;
  }
}
