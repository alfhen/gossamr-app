import type { ComponentType } from "react";
import type { WorkItem } from "../types";
import { AgeView } from "./AgeView";
import { BoardView } from "./BoardView";
import { ListView } from "./ListView";
import { MapView } from "./MapView";
import type { Tab, ViewMode } from "./tabsStore";

export interface CanvasProps {
  tab: Tab;
  /** Items matching the tab's filter, newest update first. */
  items: WorkItem[];
}

/** One canvas per view mode. */
export const CANVASES: Record<ViewMode, ComponentType<CanvasProps>> = {
  list: ListView,
  board: BoardView,
  map: MapView,
  age: AgeView,
};
