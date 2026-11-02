import type { ConnectionInfo, ItemRef, WatchState, WorkContainer, WorkItem } from "../types";
import { isWorkConnection, workConnections } from "./domains";

interface Known {
  items: Record<string, WorkItem>;
  containers: Record<string, WorkContainer>;
  connections: readonly Pick<ConnectionInfo, "id" | "kind" | "enabled">[];
  watch: readonly Pick<WatchState, "connectionId">[];
}

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const projectOfKey = (key: string) => key.slice(0, key.lastIndexOf("-"));

/** Every cached ticket with this key, one per site that has it. */
export const cachedWithKey = (items: Known["items"], key: string): WorkItem[] => Object.values(items).filter((i) => sameKey(i.item.key, key));

/** The connections a typed key can be read from: the work ones that are on, else the ones with something watched. */
const readable = (s: Known): string[] => {
  const on = workConnections(s.connections).filter((c) => c.enabled !== false);
  return on.length ? on.map((c) => c.id) : [...new Set(s.watch.map((w) => w.connectionId).filter(isWorkConnection))];
};

const sitesWithProject = (s: Known, sites: string[], key: string) => {
  const project = projectOfKey(key).toLowerCase();
  return sites.filter((id) => Object.values(s.containers).some((c) => c.ref.connectionId === id && c.key.toLowerCase() === project));
};

/**
 * The tickets a key typed by hand can mean, in the order the sites are listed. The sync holds only some of a site's tickets, so a cached one
 * doesn't rule out the other sites that have the project: they come as live refs. With nothing cached, one per site that has the project,
 * or per site that is on when none says it has.
 */
export function refsForKey(s: Known, key: string): ItemRef[] {
  const cached = cachedWithKey(s.items, key).map((i) => i.item);
  const position = (r: ItemRef) => s.connections.findIndex((c) => c.id === r.connectionId);
  const byPosition = (a: ItemRef, b: ItemRef) => position(a) - position(b) || a.connectionId.localeCompare(b.connectionId);
  const sites = readable(s);
  const live = (ids: string[]): ItemRef[] => ids.map((connectionId) => ({ connectionId, externalId: key, key }));
  if (cached.length) {
    const others = sitesWithProject(s, sites, key).filter((id) => !cached.some((r) => r.connectionId === id));
    return [...cached, ...live(others)].sort(byPosition);
  }
  const withProject = sitesWithProject(s, sites, key);
  return live(withProject.length ? withProject : sites);
}

/** Whether a key could also be on a site where it isn't cached, so a cached copy is not the whole answer. */
export const couldBeElsewhere = (s: Known, key: string): boolean => {
  const cached = cachedWithKey(s.items, key);
  return refsForKey(s, key).some((r) => !cached.some((i) => i.item.connectionId === r.connectionId));
};

/** The site's name for a ticket, only while more than one Jira site is on; otherwise a key says all there is to say. */
export function siteNamer(connections: readonly Pick<ConnectionInfo, "id" | "kind" | "enabled" | "displayName">[]): (ref: ItemRef) => string | null {
  const on = workConnections(connections).filter((c) => c.enabled !== false);
  return on.length > 1 ? (ref) => on.find((c) => c.id === ref.connectionId)?.displayName ?? null : () => null;
}
