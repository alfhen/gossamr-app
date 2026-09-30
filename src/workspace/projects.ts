import { containerKey } from "../lib/filter";
import type { ContainerRef, WorkContainer } from "../types";

const COLOURS = ["#e5883a", "#3aa87a", "#5b7cf0", "#c4508f", "#8a6d3b"];

/** A project keeps its colour because it is picked by its place in the key-sorted list. */
export function projectColour(containers: readonly WorkContainer[], ref: ContainerRef): string {
  const at = containers.findIndex((c) => containerKey(c.ref) === containerKey(ref));
  return COLOURS[Math.max(0, at) % COLOURS.length];
}

export const projectInitials = (c: WorkContainer) => c.key.slice(0, 2).toUpperCase();
