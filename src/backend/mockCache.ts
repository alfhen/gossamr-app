import type {
  ContainerRef,
  ItemRef,
  PersonRef,
  Snapshot,
  WorkCategory,
  WorkContainer,
  WorkFilter,
  WorkItem,
  WorkItemKind,
  WorkPriority,
} from "../types";

const CONNECTION = "mock";
const PRIORITIES: WorkPriority[] = ["lowest", "low", "medium", "high", "highest"];
const CATEGORY: Record<string, WorkCategory> = { new: "todo", indeterminate: "active", done: "done" };

const itemRef = (key: string): ItemRef => ({ connectionId: CONNECTION, externalId: key, key });
const personRef = (accountId: string): PersonRef => ({ connectionId: CONNECTION, accountId });
const containerOf = (key: string): ContainerRef => ({ connectionId: CONNECTION, externalId: key.split("-")[0] });

function kindOf(type: string): WorkItemKind {
  const t = type.toLowerCase();
  return t === "epic" || t === "bug" || t === "story" ? t : "task";
}

/** The mock's tickets as cached work items, the way the real backend would hold them. */
export function workItems(snap: Snapshot): WorkItem[] {
  return Object.values(snap.tickets).map((t) => {
    const priority = t.priority?.toLowerCase() as WorkPriority | undefined;
    const last = t.comments[t.comments.length - 1];
    return {
      item: itemRef(t.key),
      container: containerOf(t.key),
      kind: kindOf(t.type),
      title: t.summary,
      body: { blocks: t.description ? [{ type: "paragraph", content: [{ type: "text", text: t.description, marks: [] }] }] : [] },
      status: { id: t.status.name, name: t.status.name, category: CATEGORY[t.status.category] ?? "active" },
      assignee: t.assignee ? personRef(t.assignee.accountId) : null,
      reporter: t.reporter ? personRef(t.reporter.accountId) : null,
      priority: priority && PRIORITIES.includes(priority) ? priority : null,
      parent: t.parent ? itemRef(t.parent.key) : null,
      labels: [],
      created: t.updated,
      updated: t.updated,
      links: [],
      commentCount: t.comments.length,
      lastCommenter: last ? personRef(last.author.accountId) : null,
      extra: null,
    };
  });
}

/** One container per project key. The mock has no workflow graph, so moves are open. */
export function workContainers(snap: Snapshot): WorkContainer[] {
  const byKey = new Map<string, Map<string, WorkItem["status"]>>();
  for (const item of workItems(snap)) {
    const statuses = byKey.get(item.container.externalId) ?? new Map();
    statuses.set(item.status.id, item.status);
    byKey.set(item.container.externalId, statuses);
  }
  return [...byKey].sort().map(([key, statuses]) => ({
    ref: { connectionId: CONNECTION, externalId: key },
    key,
    name: key,
    workflow: { statuses: [...statuses.values()], transitions: { kind: "any" } },
  }));
}

function matches(f: WorkFilter, i: WorkItem, snap: Snapshot, now: number): boolean {
  const open = i.status.category !== "done";
  switch (f.type) {
    case "needsMe":
      return snap.events.some((e) => e.ticketKey === i.item.key && e.unread && !e.doneAt);
    case "mine":
      return i.assignee?.accountId === snap.me.accountId;
    case "unassigned":
      return i.assignee === null;
    case "blocked":
      return open && i.status.name === "Blocked";
    case "open":
      return open;
    case "assignee":
      return i.assignee?.accountId === f.person.accountId;
    case "status":
      return i.status.name.toLowerCase() === f.name.toLowerCase();
    case "category":
      return i.status.category === f.category;
    case "stale":
      return open && now - Date.parse(i.updated) >= f.days * 86_400_000;
    case "container":
      return i.container.externalId === f.container.externalId;
    case "parent":
      return i.parent?.externalId === f.item.externalId;
    case "label":
      return i.labels.some((l) => l.toLowerCase() === f.label.toLowerCase());
    case "text": {
      const needle = f.text.toLowerCase();
      const body = snap.tickets[i.item.key]?.description ?? "";
      return [i.title, i.item.key, body].some((s) => s.toLowerCase().includes(needle));
    }
    case "items":
      return f.items.some((r) => r.externalId === i.item.externalId);
    case "and":
      return f.filters.every((g) => matches(g, i, snap, now));
  }
}

export function search(snap: Snapshot, filter: WorkFilter): WorkItem[] {
  const now = Date.now();
  return workItems(snap)
    .filter((i) => matches(filter, i, snap, now))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}
