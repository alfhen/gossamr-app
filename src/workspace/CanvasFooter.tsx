import { BulkBar } from "./BulkBar";
import { NoticeLine } from "./Notice";
import type { useCards } from "./useCards";

/** The notice line and bulk bar every canvas shows under its content. */
export function CanvasFooter({ cards }: { cards: ReturnType<typeof useCards> }) {
  return (
    <>
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
    </>
  );
}
