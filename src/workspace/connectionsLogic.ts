import type { ConnectionInfo } from "../types";
import { stepKey } from "./peekLogic";
import { agoText } from "./watchLogic";

export type LineTone = "ok" | "quiet" | "unsure" | "error" | "busy";

export const OFF_DETAIL = "Off. Gossamr doesn't sync it and drafts for it wait. You and Pip don't see its items. What's cached is kept.";

/** Provider rows stay out of Settings until runs honour their instance. The sample backend shows them with `?providers=1`. */
export const providersShown = false;

const providersAsked = () => typeof location !== "undefined" && new URLSearchParams(location.search).get("providers") === "1";

/** The rows Settings and the rest of the page work with. */
export const shownConnections = <T extends Pick<ConnectionInfo, "kind">>(connections: readonly T[], shown = providersShown || providersAsked()): T[] =>
  shown ? [...connections] : connections.filter((c) => c.kind !== "provider");

/** Whether any GitHub account is on. Code links, the code filters and the Development section appear only then: an off connection is hidden, and what it cached comes back when it is on. */
export const showsCode = (connections: readonly Pick<ConnectionInfo, "kind" | "enabled">[]) => connections.some((c) => c.kind === "github" && c.enabled);

/** Only a row backed by an instance in config.json can be turned off; the others carry their connection id as `instanceId`. A provider is its own instance. */
export const canSwitch = (c: Pick<ConnectionInfo, "id" | "instanceId" | "kind">) => c.kind === "provider" || (c.kind !== "mock" && c.instanceId !== c.id);

/** The one line a connection's row in the list shows. */
export function statusLine(c: Pick<ConnectionInfo, "kind" | "account" | "status" | "enabled">, checking: boolean): { text: string; tone: LineTone } {
  if (c.kind === "mock" && !c.status) return { text: "Sample tickets · nothing is sent anywhere", tone: "quiet" };
  if (!c.enabled || c.status?.state === "off") return { text: "Off", tone: "quiet" };
  const s = c.status;
  if (checking) return { text: "Checking…", tone: "busy" };
  if (!s) return { text: "Not checked yet", tone: "quiet" };
  switch (s.state) {
    case "ready":
      return { text: `Authenticated · ${s.account ?? c.account}`, tone: "ok" };
    case "expiresSoon":
      return { text: s.message, tone: "unsure" };
    case "notSignedIn":
      return { text: "Not signed in", tone: "error" };
    case "notFound":
      return { text: `Not found · ${c.kind === "github" ? "gh" : c.kind}`, tone: "error" };
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
  if (c.kind === "provider") return `Remove ${c.displayName}? Its folder and the login in it stay on disk.`;
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
