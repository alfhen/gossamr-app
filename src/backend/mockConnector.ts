import { docFromText, docText } from "../lib/docs";
import { compileFilter, itemKey, type FilterContext } from "../lib/filter";
import { canMove, nextStatuses, statusOf } from "../lib/workflow";
import { MockWatch, type MockOptions } from "./mockWatch";
import type {
  CatalogPage,
  ContainerRef,
  FeedEntry,
  FeedPage,
  FeedQuery,
  Footprint,
  ItemRef,
  Person,
  PersonRef,
  Stray,
  StatusDef,
  WatchChange,
  WatchMode,
  WatchState,
  WorkCategory,
  WorkDoc,
  WorkComment,
  WorkContainer,
  WorkEvent,
  WorkFilter,
  WorkIdentity,
  WorkItem,
  WorkItemKind,
  WorkLink,
  WorkMove,
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

/** The four sample projects, then quiet ones with no items, so the catalog can be as big as a test needs. */
function catalogOf(size: number): Project[] {
  const extra = Math.max(0, size - PROJECTS.length);
  return [
    ...PROJECTS,
    ...Array.from({ length: extra }, (_, n): Project => {
      const key = `P${String(n + PROJECTS.length + 1).padStart(2, "0")}`;
      return { key, name: `Project ${key.slice(1)}`, statuses: [["To Do", "todo"], ["In Progress", "active"], ["Done", "done"]] };
    }),
  ];
}

const CATALOG_PAGE = 50;

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
  row("DEVOPS-471", "story", "Retry failed payment webhooks", "In Review", "me", 1, { parent: "DEVOPS-470", labels: ["payments"], priority: "high", body: "Retries back off and cap at five attempts.\n\nThe payment provider redelivers a webhook when we answer with anything but a 2xx, so a slow handler turns one event into a burst. The handler now acknowledges first and processes from the queue, which keeps the provider's retry clock out of our own retry maths.\n\nBackoff starts at two seconds and doubles with jitter, so a provider outage does not produce a synchronised wave when it recovers. After five attempts the event moves to the dead-letter queue with the last error attached.\n\nSee https://docs.example.com/payments/webhooks/retries/backoff-and-jitter?source=ticket&section=delivery-guarantees&utm_campaign=retry-budget-review-2026-q3 for the provider's delivery guarantees.\n\nOpen questions: whether the dead-letter replay should respect the original ordering, and who owns the alert when the queue depth crosses the threshold." }),
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
  row("CA-208", "task", "Route checkout through the gateway", "QA", "me", 1, { labels: ["payments"], body: "Moves the checkout calls onto the gateway; the rollout is tracked in DEVOPS-471." }),
  row("CA-209", "task", "Warm the category cache", "Backlog", "me", 2),
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

/** Replies to DEVOPS-471's comments: the quoted comment's author and text, then what the replier wrote. */
const REPLIES: [key: string, author: PersonId, minutesAgo: number, to: PersonId, quoted: string, text: string][] = [
  ["DEVOPS-471", "me", 60 * 4, "priya", "Looks right to me. One nit: the jitter should be full jitter, not equal jitter.", "Agreed, switching to full jitter in the next push."],
  ["DEVOPS-471", "sam", 60 * 2, "jonas", "Stack from staging: Error: connect ETIMEDOUT 10.0.12.34:443 at TCPConnectWrap.afterConnect (node:net:1611:16) at /srv/app/node_modules/payment-client/dist/retry/backoffWithJitter.js:88:21", "That timeout is the connect phase, not the handler. Is the staging egress allow-listed for the provider?"],
];

const replyDoc = (to: string, who: string, quoted: string, text: string): WorkDoc => ({
  blocks: [
    { type: "paragraph", content: [{ type: "mention", person: { connectionId: MOCK_CONNECTION, accountId: to }, name: who }] },
    { type: "quote", content: [{ type: "paragraph", content: [{ type: "text", text: quoted, marks: [] }] }] },
    { type: "paragraph", content: [{ type: "text", text, marks: [] }] },
  ],
});

const COMMENTS: [key: string, author: PersonId, minutesAgo: number, text: string][] = [
  ["DEVOPS-471", "sam", 90, "Ready for another look, retries now cap at five."],
  ["DEVOPS-471", "mette", 60 * 24 * 3, "Please keep the backoff configurable per provider.\n\nThe reference from the provider docs is https://docs.example.com/payments/webhooks/retries/backoff-and-jitter?source=review&section=delivery-guarantees&utm_campaign=retry-budget-review-2026-q3 and it is long on purpose."],
  ["DEVOPS-471", "jonas", 60 * 24 * 2, "Stack from staging: Error: connect ETIMEDOUT 10.0.12.34:443 at TCPConnectWrap.afterConnect (node:net:1611:16) at /srv/app/node_modules/payment-client/dist/retry/backoffWithJitter.js:88:21"],
  ["DEVOPS-471", "me", 60 * 24, "Thanks both. I capped it at five and made the base delay a setting; the dead-letter replay is next."],
  ["DEVOPS-471", "priya", 60 * 6, "Looks right to me. One nit: the jitter should be full jitter, not equal jitter."],
  ["DEVOPS-472", "sam", 60 * 24 * 5, "Queue is provisioned in staging."],
  ["DEVOPS-473", "jonas", 60 * 24 * 2, "Waiting on the backfill before I can reproduce this."],
  ["CA-404", "ida", 60 * 24 * 3, "Can't test the segment until the sign-up form ships."],
  ["CA-409", "mette", 300, "@Alf Henderson can you check the legal wording?"],
  ["WEB-101", "priya", 45, "Swatches flicker on Safari, could you take a look?"],
  ["WEB-102", "priya", 60 * 24, "Form is validated, waiting on the copy."],
  ["SUP-12", "klara", 20, "The customer replied with their bank reference."],
];

const MORE_COMMENTS: typeof COMMENTS = [
  ["DEVOPS-490", "sam", 12, "@Alf Henderson does the 30s include the connect timeout?"],
  ["DEVOPS-490", "byron", 55, "Backfill is running in staging, no errors so far."],
  ["DEVOPS-493", "jonas", 8 * 60, "Replay skips dead-lettered events only when the batch is full."],
  ["WEB-108", "ida", 3 * 60, "@Alf Henderson the size guide needs the new EU chart."],
  ["WEB-104", "priya", 26 * 60, "Reproduced on iPhone 12, swatches push the title 40px."],
  ["CA-402", "mette", 34 * 60, "Variant B reads better, can we test it against A?"],
  ["CA-400", "mette", 2 * 60, "@Alf Henderson can you confirm the 17 Oct go-live works for the CRM side?"],
  ["SUP-14", "byron", 5 * 60, "The 404 only happens for parcels shipped from the Aarhus depot."],
  ["SUP-10", "klara", 70, "Discount code is valid but the cart says it's expired."],
  ["DEVOPS-478", "jonas", 60 * 24 * 4, "Blocked until the queue is in production."],
  ["WEB-102", "me", 40, "Copy is on its way."],
];

const ASSIGNMENTS: [key: string, actor: PersonId, minutesAgo: number][] = [
  ["DEVOPS-490", "sam", 30],
  ["WEB-108", "priya", 28 * 60],
  ["CA-402", "mette", 60 * 24 * 3],
  ["SUP-12", "klara", 6 * 60],
];

const MORE_CHANGES: typeof CHANGES = [
  ["DEVOPS-493", "jonas", 40, "Code review", "In Review"],
  ["WEB-105", "ida", 2 * 60 + 10, "Backlog", "To Do"],
  ["SUP-13", "klara", 7 * 60, "Investigating", "Resolved"],
  ["WEB-103", "byron", 27 * 60, "In Progress", "Testing"],
  ["CA-404", "ida", 60 * 24 * 6, "Design", "QA"],
];

const CHANGES: [key: string, actor: PersonId, minutesAgo: number, from: string, to: string][] = [
  ["DEVOPS-471", "me", 60 * 26, "In Progress", "In Review"],
  ["DEVOPS-473", "jonas", 60 * 24 * 9, "In Progress", "Blocked"],
  ["CA-406", "byron", 60 * 20, "QA", "Scheduled"],
  ["WEB-106", "ida", 60 * 24 * 9, "Testing", "Released"],
];

const PRIORITY_FALLBACK: WorkPriority = "medium";

export type Change = { connectionId: string };

/** Events by other people this recent start unread. */
const UNREAD_WINDOW_MINUTES = 36 * 60;
const FEED_PAGE = 50;

/** A tracker held in memory: several projects, each with its own workflow, and the events around their items. */
export class MockConnector {
  readonly connectionId = MOCK_CONNECTION;
  readonly me = personRef("me");
  readonly people: Person[] = Object.entries(PEOPLE).map(([accountId, name]) => ({ accountId, name }));
  private items = new Map<string, WorkItem>();
  private events = new Map<string, WorkEvent[]>();
  private markedRead = new Set<string>();
  private containers: WorkContainer[];
  private seq = 0;
  private nextNumber: Record<string, number> = {};

  readonly watch: MockWatch;
  private catalog: Project[];
  private watchListeners = new Set<(c: Change) => void>();

  constructor(
    private readonly now: number = Date.now(),
    private readonly onChange: (c: Change) => void = () => {},
    options: MockOptions = {},
  ) {
    this.catalog = catalogOf(options.catalogSize ?? PROJECTS.length);
    this.watch = new MockWatch(MOCK_CONNECTION, this.catalog.length);
    this.containers = this.catalog.map((p) => ({ ref: containerRef(p.key), key: p.key, name: p.name, workflow: workflowOf(p) }));
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
    for (const [key, author, minutes, to, quoted, text] of REPLIES) {
      const reply = replyDoc(to, PEOPLE[to], quoted, text);
      this.record(key, "commentAdded", author, at(minutes), { text: docText(reply), doc: reply });
      const item = this.items.get(key)!;
      item.commentCount += 1;
      item.lastCommenter = personRef(author);
    }
    for (const [from, to, kind] of LINKS) {
      const item = this.items.get(from)!;
      item.links = [...item.links, { from: itemRef(from), to: itemRef(to), kind }];
    }
    for (const [key, author, minutes, text] of [...COMMENTS, ...MORE_COMMENTS]) {
      this.record(key, "commentAdded", author, at(minutes), text.includes("@Alf") ? { text, mention: true } : { text });
      const item = this.items.get(key)!;
      item.commentCount += 1;
      item.lastCommenter = personRef(author);
    }
    for (const [key, actor, minutes, from, to] of [...CHANGES, ...MORE_CHANGES]) this.record(key, "statusChanged", actor, at(minutes), { from, to, text: `${from} → ${to}` });
    for (const [key, actor, minutes] of ASSIGNMENTS) this.record(key, "assigned", actor, at(minutes), { text: "Assigned to you" });
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
    return { me: [this.me], now: this.now, needsMe: this.needsMe() };
  }

  /** Unread events, plus mentions and comments on my own items that I haven't answered on open items. */
  private needsMe(): Set<string> {
    const mine = this.me.accountId;
    const out = new Set<string>();
    for (const [key, events] of this.events) {
      const item = this.items.get(key);
      if (!item || !this.watch.isWatched(item.container.externalId)) continue;
      const byOthers = events.filter((e) => e.actor && e.actor.accountId !== mine);
      const unread = byOthers.some((e) => this.now - new Date(e.at).getTime() < UNREAD_WINDOW_MINUTES * 60_000 && !this.markedRead.has(e.id));
      if (unread) {
        out.add(itemKey(item.item));
        continue;
      }
      if (item.status.category === "done") continue;
      const latest = (keep: (e: WorkEvent) => boolean) => events.filter((e) => e.actor?.accountId === mine && keep(e)).reduce((at, e) => (e.at > at ? e.at : at), "");
      const replied = latest((e) => e.kind === "commentAdded");
      const acted = latest(() => true);
      const comments = byOthers.filter((e) => e.kind === "commentAdded");
      const mentioned = comments.some((e) => (e.payload as { mention?: boolean } | null)?.mention === true && e.at > replied);
      const onMine = item.assignee?.accountId === mine && comments.some((e) => e.at > acted);
      if (mentioned || onMine) out.add(itemKey(item.item));
    }
    return out;
  }

  has(ref: ItemRef) {
    return ref.connectionId === MOCK_CONNECTION && this.items.has(ref.externalId);
  }

  /** Items that match, newest first. Only watched containers unless `includeUnwatched`. */
  search(filter: WorkFilter, includeUnwatched = false): WorkItem[] {
    const all = [...this.items.values()].filter((i) => includeUnwatched || this.watch.isWatched(i.container.externalId));
    return all.filter(compileFilter(filter, all, this.ctx)).sort((a, b) => b.updated.localeCompare(a.updated));
  }

  item(ref: ItemRef): WorkItem | null {
    return ref.connectionId === MOCK_CONNECTION ? (this.items.get(ref.externalId) ?? null) : null;
  }

  /** A watched item as the cache has it; any other is read "live" and flagged, the way the real backend peeks. */
  cacheItem(ref: ItemRef): WorkItem | null {
    const item = this.item(ref);
    return item && this.watch.isWatched(item.container.externalId) ? item : this.peek(ref);
  }

  peek(ref: ItemRef): WorkItem | null {
    const item = this.item(ref);
    return item ? { ...item, unwatched: !this.watch.isWatched(item.container.externalId) } : null;
  }

  listContainers(includeUnwatched = false): WorkContainer[] {
    return this.containers.filter((c) => includeUnwatched || this.watch.isWatched(c.ref.externalId));
  }

  watchState(): WatchState {
    return this.watch.state((id) => {
      const c = this.containers.find((x) => x.ref.externalId === id);
      return { key: c?.key ?? id, name: c?.name ?? id, cachedItems: [...this.items.values()].filter((i) => i.container.externalId === id).length };
    });
  }

  setWatchMode(mode: WatchMode) {
    this.watch.setMode(mode);
    this.watchChanged();
  }

  setWatched(changes: WatchChange[]) {
    this.watch.apply(changes);
    this.watchChanged();
  }

  private watchChanged() {
    this.watchListeners.forEach((l) => l({ connectionId: MOCK_CONNECTION }));
    this.onChange({ connectionId: MOCK_CONNECTION });
  }

  onWatchChanged(listener: (c: Change) => void) {
    this.watchListeners.add(listener);
    return () => void this.watchListeners.delete(listener);
  }

  /** The catalog, matching on key or name, fifty at a time. */
  catalogPage(query: string, cursor: string | null): CatalogPage {
    const q = query.trim().toLowerCase();
    const matches = this.containers.filter((c) => !q || c.key.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    const start = cursor ? Number(cursor) : 0;
    const page = matches.slice(start, start + CATALOG_PAGE);
    return {
      containers: page.map((c) => ({ ref: c.ref, key: c.key, name: c.name, kind: null, archived: false, lastActive: null, itemHint: null, watched: this.watch.isWatched(c.ref.externalId) })),
      next: start + CATALOG_PAGE < matches.length ? String(start + CATALOG_PAGE) : null,
      offline: false,
    };
  }

  /** Where the signed-in person is involved, counted from the sample items. */
  footprint(): Footprint[] {
    const byProject = new Map<string, Footprint>();
    for (const i of this.items.values()) {
      const mine = i.assignee?.accountId === this.me.accountId;
      const reported = i.reporter?.accountId === this.me.accountId;
      if (!mine && !reported) continue;
      const id = i.container.externalId;
      const c = this.containers.find((x) => x.ref.externalId === id)!;
      const f = byProject.get(id) ?? { container: c.ref, key: c.key, name: c.name, assigned: 0, reported: 0, watching: 0, commented: null, mentioned: null, lastTouch: null };
      if (mine) f.assigned += 1;
      if (reported) f.reported += 1;
      if (!f.lastTouch || i.updated > f.lastTouch) f.lastTouch = i.updated;
      byProject.set(id, f);
    }
    return [...byProject.values()].sort((a, b) => b.assigned - a.assigned || a.key.localeCompare(b.key));
  }

  /** Open items assigned to the person in projects they don't watch. */
  strays(): Stray[] {
    const out = new Map<string, Stray>();
    for (const i of this.items.values()) {
      const id = i.container.externalId;
      if (i.assignee?.accountId !== this.me.accountId || i.status.category === "done" || this.watch.isWatched(id)) continue;
      const c = this.containers.find((x) => x.ref.externalId === id)!;
      const s = out.get(id) ?? { container: c.ref, containerName: c.name, keys: [] };
      s.keys.push(i.item.key);
      out.set(id, s);
    }
    return [...out.values()];
  }

  workflow(c: ContainerRef): Workflow | null {
    return this.containers.find((x) => x.ref.externalId === c.externalId && c.connectionId === MOCK_CONNECTION)?.workflow ?? null;
  }

  identity(): WorkIdentity {
    return { displayName: PEOPLE.me, accounts: [this.me] };
  }

  /** Comments recorded as events, oldest first. */
  comments(ref: ItemRef): WorkComment[] {
    return this.eventsFor(ref)
      .filter((e) => e.kind === "commentAdded")
      .map((e) => ({
        id: e.id,
        author: e.actor ?? this.me,
        body: (e.payload as { doc?: WorkDoc } | null)?.doc ?? docFromText(String((e.payload as { text?: unknown } | null)?.text ?? "")),
        created: e.at,
        mentions: [],
      }))
      .reverse();
  }

  /** The statuses the item's workflow lets it move to, named the way a tracker would offer them. */
  moves(ref: ItemRef): WorkMove[] {
    const item = this.item(ref);
    const wf = item && this.workflow(item.container);
    return item && wf ? nextStatuses(wf, item.status.id).map((to) => ({ name: to.name, to })) : [];
  }

  /** Events across every item, newest first, the way the cache's feed pages them. */
  feed(q: FeedQuery): FeedPage {
    const limit = Math.min(q.limit || FEED_PAGE, 200);
    const cursor = q.before;
    const matches: FeedEntry[] = [];
    for (const e of [...this.events.values()].flat()) {
      if (e.subject.type !== "item" || e.kind === "itemCreated") continue;
      const entry = this.entry(e, e.subject.item);
      if (q.kinds?.length && !q.kinds.includes(e.kind)) continue;
      if (q.mentionsOnly && !entry.mention) continue;
      if (q.unreadOnly && !entry.unread) continue;
      if (q.container && this.items.get(entry.item.externalId)?.container.externalId !== q.container.externalId) continue;
      const container = this.items.get(entry.item.externalId)?.container.externalId;
      if (!q.includeUnwatched && (!container || !this.watch.isWatched(container))) continue;
      matches.push(entry);
    }
    matches.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const after = cursor ? matches.filter((e) => e.at < cursor.at || (e.at === cursor.at && e.id < cursor.id)) : matches;
    const entries = after.slice(0, limit);
    const last = entries[entries.length - 1];
    return { entries, next: after.length > limit && last ? { at: last.at, id: last.id } : null };
  }

  feedUnread(): number {
    return this.feed({ unreadOnly: true, limit: 200 }).entries.length;
  }

  /** Marks a feed entry read or unread; false when the id isn't one of this connector's events. */
  setRead(id: string, read: boolean): boolean {
    if (![...this.events.values()].flat().some((e) => e.id === id)) return false;
    if (read) this.markedRead.add(id);
    else this.markedRead.delete(id);
    this.onChange({ connectionId: MOCK_CONNECTION });
    return true;
  }

  private entry(e: WorkEvent, item: ItemRef): FeedEntry {
    const payload = (e.payload ?? {}) as { text?: string; mention?: boolean; from?: string; to?: string };
    const byOther = e.actor !== null && e.actor.accountId !== this.me.accountId;
    const recent = this.now - new Date(e.at).getTime() < UNREAD_WINDOW_MINUTES * 60_000;
    return {
      id: e.id,
      connectionId: e.connectionId,
      at: e.at,
      kind: e.kind,
      item,
      itemTitle: this.items.get(item.externalId)?.title ?? null,
      actor: e.actor,
      actorName: e.actor ? (PEOPLE[e.actor.accountId as PersonId] ?? null) : null,
      text: payload.text ?? "",
      mention: payload.mention === true,
      unread: byOther && recent && !this.markedRead.has(e.id),
      done: false,
    };
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

  comment(ref: ItemRef, text: string, doc?: WorkDoc) {
    const item = this.item(ref);
    if (!item) throw new Error(`${ref.key} isn't in the sample data`);
    const at = new Date().toISOString();
    this.items.set(ref.externalId, { ...item, commentCount: item.commentCount + 1, lastCommenter: this.me, updated: at });
    this.record(ref.externalId, "commentAdded", "me", at, doc ? { text, doc } : { text });
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
