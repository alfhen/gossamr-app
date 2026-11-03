import { containerKey } from "../lib/filter";
import type { ContainerRef, WorkContainer } from "../types";

const COLOURS = ["#e5883a", "#3aa87a", "#5b7cf0", "#c4508f", "#8a6d3b"];

/** A project keeps its colour because it is picked by its place in the key-sorted list. */
export function projectColour(containers: readonly WorkContainer[], ref: ContainerRef): string {
  const at = containers.findIndex((c) => containerKey(c.ref) === containerKey(ref));
  return COLOURS[Math.max(0, at) % COLOURS.length];
}

/** A container's name for the rail: with its site's name when another site has a container with the same key. */
export function projectLabels(containers: readonly WorkContainer[], siteOf: (c: WorkContainer) => string | null): (c: WorkContainer) => string {
  const sites = new Map<string, Set<string>>();
  for (const c of containers) sites.set(c.key.toLowerCase(), (sites.get(c.key.toLowerCase()) ?? new Set()).add(c.ref.connectionId));
  return (c) => {
    const site = (sites.get(c.key.toLowerCase())?.size ?? 0) > 1 ? siteOf(c) : null;
    return site ? `${c.name} · ${site}` : c.name;
  };
}

export const projectInitials = (c: WorkContainer) => c.key.slice(0, 2).toUpperCase();

/** A colour for a container that isn't in the watched list, such as a row in the picker; stable for a given key. */
export function keyColour(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return COLOURS[h % COLOURS.length];
}

export const keyInitials = (key: string) => key.slice(0, 2).toUpperCase();
