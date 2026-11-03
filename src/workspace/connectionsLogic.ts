import type { ConnectionInfo, ModelChoice, ModelDefaults, Run } from "../types";
import { DRIVERS } from "../lib/models";
import { stepKey } from "./peekLogic";
import { DEFAULT_INSTANCE, instanceOf } from "./providerLogic";
import { agoText } from "./watchLogic";

export type LineTone = "ok" | "quiet" | "unsure" | "error" | "busy";

export const OFF_DETAIL = "Off. Gossamr doesn't sync it and drafts for it wait. You and Pip don't see its items. What's cached is kept.";
export const PROVIDER_OFF_DETAIL = "Off. Pip and new agents can't use it.";

/** Whether Settings lists provider rows. */
export const providersShown = true;

/** The rows Settings and the rest of the page work with. */
export const shownConnections = <T extends Pick<ConnectionInfo, "kind">>(connections: readonly T[], shown = providersShown): T[] =>
  shown ? [...connections] : connections.filter((c) => c.kind !== "provider");

export type ConnectionGroup = "Code" | "Tickets" | "Models";

export const ADD_GROUPS: readonly ConnectionGroup[] = ["Code", "Tickets", "Models"];

export const groupOf = (kind: ConnectionInfo["kind"]): ConnectionGroup => (kind === "github" ? "Code" : kind === "provider" ? "Models" : "Tickets");

/** The rows under their group headings, in the order Settings shows them. Empty groups are left out. */
export function groupedConnections<T extends Pick<ConnectionInfo, "kind">>(connections: readonly T[]): { group: ConnectionGroup; rows: T[] }[] {
  return ADD_GROUPS.map((group) => ({ group, rows: connections.filter((c) => groupOf(c.kind) === group) })).filter((g) => g.rows.length > 0);
}

export type AddEntryId = "github" | "jira" | "claude" | "codex";

export interface AddEntry {
  id: AddEntryId;
  group: ConnectionGroup;
  label: string;
  line: string;
  beta?: boolean;
}

/** What + Add and the palette offer. Codex is offered with a Beta label; it runs agents and never Pip. */
export function addEntries(providers = providersShown): AddEntry[] {
  const entries: AddEntry[] = [
    { id: "github", group: "Code", label: "GitHub account", line: "Pull requests, branches and checks." },
    { id: "jira", group: "Tickets", label: "Jira account", line: "Tickets from one Jira site." },
  ];
  if (providers) {
    entries.push({ id: "claude", group: "Models", label: DRIVERS.claude.label, line: "A login that Pip and agents can run on.", beta: DRIVERS.claude.beta });
    entries.push({ id: "codex", group: "Models", label: DRIVERS.codex.label, line: "A login that agents can run on. Pip stays on Claude.", beta: DRIVERS.codex.beta });
  }
  return entries;
}

/** The defaults with one of the two replaced. Agents never carry an effort, which only Pip's turns take. */
export function defaultsWith(defaults: ModelDefaults, which: "pip" | "agents", choice: ModelChoice): ModelDefaults {
  if (which === "pip") return { ...defaults, pip: choice };
  const { effort: _effort, ...agents } = choice;
  return { ...defaults, agents };
}

/** Whether removing `c` leaves no other Jira connection, so the app has nothing to show and goes back to Setup. */
export const removesLastJira = (connections: readonly Pick<ConnectionInfo, "kind" | "instanceId">[], c: Pick<ConnectionInfo, "kind" | "instanceId">) =>
  c.kind === "jira" && !connections.some((o) => o.kind === "jira" && o.instanceId !== c.instanceId);

/** Whether a GitHub or Jira connection exists. The sample data and providers don't count. */
export const hasRealConnection = (connections: readonly Pick<ConnectionInfo, "kind">[]) => connections.some((c) => c.kind === "github" || c.kind === "jira");

/** Whether any GitHub account is on. Code links, the code filters and the Development section appear only then: an off connection is hidden, and what it cached comes back when it is on. */
export const showsCode = (connections: readonly Pick<ConnectionInfo, "kind" | "enabled">[]) => connections.some((c) => c.kind === "github" && c.enabled);

/** The one placeholder row standing in for a providers list that could not be read: a provider with no driver and a problem in `error`. */
export const isUnreadableProviders = (c: Pick<ConnectionInfo, "kind"> & Partial<Pick<ConnectionInfo, "driver" | "error">>) => c.kind === "provider" && !c.driver && !!c.error;

/** Only a row backed by an instance in config.json can be turned off; the others carry their connection id as `instanceId`. A provider is its own instance, except the unreadable-providers row. */
export const canSwitch = (c: Pick<ConnectionInfo, "id" | "instanceId" | "kind"> & Partial<Pick<ConnectionInfo, "driver" | "error">>) =>
  (c.kind === "provider" && !isUnreadableProviders(c)) || (c.kind !== "mock" && c.kind !== "provider" && c.instanceId !== c.id);

/** The one line a connection's row in the list shows. */
export function statusLine(c: Pick<ConnectionInfo, "kind" | "account" | "status" | "enabled"> & Partial<Pick<ConnectionInfo, "driver" | "error">>, checking: boolean): { text: string; tone: LineTone } {
  if (isUnreadableProviders(c)) return { text: c.error!, tone: "error" };
  if (c.kind === "mock" && !c.status) return { text: "Sample tickets · nothing is sent anywhere", tone: "quiet" };
  if (!c.enabled || c.status?.state === "off") return { text: "Off", tone: "quiet" };
  const s = c.status;
  if (checking) return { text: "Checking…", tone: "busy" };
  if (!s) return { text: "Not checked yet", tone: "quiet" };
  switch (s.state) {
    case "ready":
      // A provider's message already says what the login is: an email, ChatGPT, an API key from the shell.
      return { text: c.kind === "provider" ? s.message : `Authenticated · ${s.account ?? c.account}`, tone: "ok" };
    case "expiresSoon":
      return { text: s.message, tone: "unsure" };
    case "notSignedIn":
      return { text: "Not signed in", tone: "error" };
    case "notFound":
      return { text: `Not found · ${c.kind === "github" ? "gh" : c.kind === "provider" ? (c.driver ?? "provider") : c.kind}`, tone: "error" };
    case "error":
      return { text: "Couldn't check", tone: "unsure" };
    case "off":
      return { text: "Off", tone: "quiet" };
  }
}

/** A Jira or GitHub connection that is on and that Gossamr can no longer sign in as. For GitHub that includes a `gh` that isn't installed. A provider never counts: the Jira banner is not about it. */
export function isSignedOut(c: Pick<ConnectionInfo, "kind" | "enabled" | "reauth" | "status">): boolean {
  return c.kind !== "provider" && c.enabled && (c.reauth || c.status?.state === "notSignedIn" || (c.kind === "github" && c.status?.state === "notFound"));
}

/** When the oldest probe among `connections` ran: the time "Checked 3m ago" at the top of the list can promise. */
export function oldestCheck(connections: Pick<ConnectionInfo, "status">[]): string | null {
  const times = connections.flatMap((c) => (c.status ? [c.status.checkedAt] : []));
  return times.length ? times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

/** What the detail pane and the Connect GitHub sheet say about the account agents clone and push as. */
export const agentsPush = (activeLogin: string | null) =>
  activeLogin ? `gh's active account is ${activeLogin}. Agents clone and push with your own git and gh setup, which may be a different account.` : "Agents clone and push with your own git and gh setup, which may be a different account.";

/** Whose drafts and agents act as which account, for the detail pane. */
export function actingAs(c: Pick<ConnectionInfo, "kind" | "workspace" | "account" | "status">): string[] {
  if (c.kind === "github") return [`Drafts post as ${c.workspace} via GitHub.`, agentsPush(c.status?.activeLogin ?? null)];
  if (c.kind === "jira") return [`Drafts post as ${c.account} via Jira.`];
  return [];
}

/** What Remove tells you it deletes, before it does. */
export function removalWarning(c: Pick<ConnectionInfo, "kind" | "displayName" | "workspace">): string {
  if (c.kind === "github") {
    return `Remove ${c.displayName}? Gossamr deletes the pull requests and branches it cached for ${c.workspace} and closes the drafts that post as ${c.workspace}. Your gh login and GitHub stay as they are.`;
  }
  if (c.kind === "provider") return `Remove ${c.displayName}? Gossamr stops offering it. Runs and Pip conversations that used it keep their history, and your login and folder stay as they are. Settings and workstreams set to it need a new choice.`;
  return `Remove ${c.displayName}? Gossamr deletes the tickets it cached, forgets your token and closes the drafts for it. Jira stays as it is.`;
}

/** The row an arrow key moves to; the ends hold. */
export function rowAfter(ids: string[], current: string | null, key: string): string | null {
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  return step ? stepKey(ids, current, step) : null;
}

/** What the sync of a connection is doing, for its detail and its watch card. */
export function syncLine(c: Pick<ConnectionInfo, "syncing" | "lastSyncAt" | "error"> & { transient?: boolean }, now: Date): { text: string; tone: "ok" | "busy" | "error" } {
  if (c.syncing) return { text: "Syncing…", tone: "busy" };
  const last = c.lastSyncAt ? `Last synced ${agoText(c.lastSyncAt, now)}` : "Not synced yet";
  if (c.error && c.transient) return { text: `${last}. Network trouble, trying again soon: ${c.error}`, tone: "busy" };
  return c.error ? { text: `${last}. Couldn't sync: ${c.error}`, tone: "error" } : { text: last, tone: "ok" };
}

export interface WaitingLogin extends Pick<ConnectionInfo, "id" | "kind" | "displayName" | "instanceId"> {
  signIn: string | null;
}

const waitsOnLogin = (run: Run) => run.state === "queued" || run.state === "systemBlocked" || (run.state === "failed" && !run.shortId && run.failure?.type === "notSignedIn");

/**
 * The Claude and Codex logins that are signed out while something needs them: a run that waits for it or stopped on it, or a Settings
 * default (Pip, new agents). A signed-out login nothing uses stays quiet in Settings.
 */
export function providersNeedingSignIn(connections: readonly ConnectionInfo[], runs: readonly Run[], defaults: ModelDefaults | null): WaitingLogin[] {
  const used = new Set<string>([defaults?.pip?.instanceId, defaults?.agents?.instanceId].filter((id): id is string => !!id));
  for (const r of runs) if (waitsOnLogin(r)) used.add(r.runsOn?.instanceId ?? DEFAULT_INSTANCE);
  return connections
    .filter((c) => c.kind === "provider" && c.enabled && c.status?.state === "notSignedIn" && used.has(c.instanceId))
    .map((c) => ({ id: c.id, kind: c.kind, displayName: c.displayName, instanceId: c.instanceId, signIn: instanceOf(connections, c.instanceId).signIn }));
}
