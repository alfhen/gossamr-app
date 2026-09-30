import { useTabs } from "./tabsStore";
import { PEEK_DEFAULT, PIP_DEFAULT, fitPanes } from "./paneSizes";
import { usePrefs } from "./prefs";
import { ResizeHandle, useResize, useWindowWidth } from "./ResizeHandle";

export function usePaneWidths() {
  const windowWidth = useWindowWidth();
  const peek = usePrefs((s) => s.peekWidth);
  const pip = usePrefs((s) => s.pipWidth);
  const pipOpen = usePrefs((s) => s.pipOpen);
  const peekOpen = useTabs((s) => !!s.selected && s.marked.length <= 1);
  return fitPanes(windowWidth, peek, pip, pipOpen, peekOpen);
}

export function PeekResizer() {
  const { peek, peekLimits } = usePaneWidths();
  const resize = useResize({ value: peek, limits: peekLimits, fallback: PEEK_DEFAULT, onChange: usePrefs.getState().setPeekWidth });
  return <ResizeHandle label="Resize ticket panel" value={peek} limits={peekLimits} {...resize} />;
}

export function PipResizer() {
  const { pip, pipLimits } = usePaneWidths();
  const resize = useResize({ value: pip, limits: pipLimits, fallback: PIP_DEFAULT, onChange: usePrefs.getState().setPipWidth });
  return <ResizeHandle label="Resize Pip panel" value={pip} limits={pipLimits} {...resize} />;
}
