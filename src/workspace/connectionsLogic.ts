import type { ConnectionInfo } from "../types";
import { stepKey } from "./peekLogic";
import { agoText } from "./watchLogic";

export type LineTone = "ok" | "quiet" | "unsure" | "error" | "busy";

export const OFF_DETAIL = "Off. Gossamr doesn't sync it, Pip can't see it and drafts for it wait. What's cached is kept.";

/** Only a row backed by an instance in config.json can be turned off; the others carry their connection id as `instanceId`. */
export const canSwitch = (c: Pick<ConnectionInfo, "id" | "instanceId" | "kind">) => c.kind !== "mock" && c.instanceId !== c.id;

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

/** A connection that is on and that Gossamr can no longer sign in as. For GitHub that includes a `gh` that isn't installed. */
export function isSignedOut(c: Pick<ConnectionInfo, "enabled" | "reauth" | "status">): boolean {
  return c.enabled && (c.reauth || c.status?.state === "notSignedIn" || c.status?.state === "notFound");
}

/** When the oldest probe among `connections` ran: the time "Checked 3m ago" at the top of the list can promise. */
export function oldestCheck(connections: Pick<ConnectionInfo, "status">[]): string | null {
  const times = connections.flatMap((c) => (c.status ? [c.status.checkedAt] : []));
  return times.length ? times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

/** Whose drafts and agents act as which account, for the detail pane. */
export function actingAs(c: Pick<ConnectionInfo, "kind" | "workspace" | "account">): string[] {
  if (c.kind === "github") return [`Drafts post as ${c.workspace} via GitHub.`, "Agents clone and push as whichever account gh has active."];
  if (c.kind === "jira") return [`Drafts post as ${c.account} via Jira.`];
  return [];
}

/** What Remove tells you it deletes, before it does. */
export function removalWarning(c: Pick<ConnectionInfo, "kind" | "displayName" | "workspace">): string {
  if (c.kind === "github") {
    return `Remove ${c.displayName}? Gossamr deletes the pull requests and branches it cached for ${c.workspace}, forgets its token and closes the drafts that post as ${c.workspace}. Your gh login and GitHub stay as they are.`;
  }
  return `Remove ${c.displayName}? Gossamr deletes the tickets it cached and your conversations with Pip, forgets your token and closes the drafts for it. Jira stays as it is.`;
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
