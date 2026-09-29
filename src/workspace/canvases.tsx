import type { ComponentType } from "react";
import type { WorkItem } from "../types";
import { ListView } from "./ListView";
import type { Tab, ViewMode } from "./tabsStore";
import { VIEW_LABEL } from "./tabsStore";

export interface CanvasProps {
  tab: Tab;
  /** Items matching the tab's filter, newest update first. */
  items: WorkItem[];
}

function Soon({ view }: { view: ViewMode }) {
  return (
    <div className="grid h-full place-items-center p-10 text-center text-ws-ink3">
      <p>The {VIEW_LABEL[view]} view is on its way. The filter and selection carry over when it arrives.</p>
    </div>
  );
}

/** One canvas per view mode; a later step replaces its entry to fill in the view. */
export const CANVASES: Record<ViewMode, ComponentType<CanvasProps>> = {
  list: ListView,
  board: () => <Soon view="board" />,
  map: () => <Soon view="map" />,
  age: () => <Soon view="age" />,
};
