import { containerKey } from "../lib/filter";
import type { ContainerRef, WorkContainer } from "../types";

const COLOURS = ["#e5883a", "#3aa87a", "#5b7cf0", "#c4508f", "#8a6d3b"];

/** A project keeps its colour because it is picked by its place in the key-sorted list. */
export function projectColour(containers: readonly WorkContainer[], ref: ContainerRef): string {
  const at = containers.findIndex((c) => containerKey(c.ref) === containerKey(ref));
  return COLOURS[Math.max(0, at) % COLOURS.length];
}

export const projectInitials = (c: WorkContainer) => c.key.slice(0, 2).toUpperCase();

/** A colour for a container that isn't in the watched list, such as a row in the picker; stable for a given key. */
export function keyColour(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return COLOURS[h % COLOURS.length];
}

export const keyInitials = (key: string) => key.slice(0, 2).toUpperCase();
