import { useLayoutEffect, useRef } from "react";
import { BulkBar } from "./BulkBar";
import { NoticeLine } from "./Notice";
import { ShortcutHint } from "./ShortcutHint";
import type { ViewMode } from "./tabsStore";
import type { useCards } from "./useCards";

export const FOOTER_HEIGHT_VAR = "--ws-footer-h";

/** Publishes its height on the root so floating layers (Pip launcher, toasts) can sit above it. */
function useFooterHeight() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(FOOTER_HEIGHT_VAR, `${el.offsetHeight}px`);
    publish();
    const watch = new ResizeObserver(publish);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty(FOOTER_HEIGHT_VAR);
    };
  }, []);
  return ref;
}

/** The bar every canvas ends with: notice, bulk actions, then the key hints on a fixed-height line. */
export function CanvasFooter({ cards, view }: { cards: ReturnType<typeof useCards>; view: ViewMode }) {
  const ref = useFooterHeight();
  return (
    <footer ref={ref} className="@container shrink-0 border-t border-ws-sep bg-ws-win">
      <NoticeLine notice={cards.notice} onDismiss={cards.dismissNotice} />
      {cards.bulk.marked.length > 1 && (
        <BulkBar
          count={cards.bulk.marked.length}
          targets={cards.bulk.targets}
          approvable={cards.bulk.approvable}
          confirming={cards.bulk.confirming}
          onMoveAll={(n) => void cards.bulk.move(n)}
          onAsk={cards.bulk.ask}
          onCancel={cards.bulk.cancel}
          onApprove={() => void cards.bulk.approve()}
          onClear={cards.bulk.clear}
        />
      )}
      <div className="flex h-8 items-center gap-4 px-6 text-xs text-ws-ink3">
        <ShortcutHint view={view} />
      </div>
    </footer>
  );
}
