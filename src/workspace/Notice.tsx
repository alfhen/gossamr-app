import type { Notice } from "./useCards";
import { Button } from "../components/Button";

export function NoticeLine({ notice, onDismiss }: { notice: Notice | null; onDismiss(): void }) {
  return (
    <div role="status" className="empty:hidden px-6 py-1 text-sm">
      {notice && (
        <p className={notice.tone === "error" ? "text-ws-blocked" : "text-ws-ink2"}>
          {notice.text}{" "}
          <Button variant="quiet" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </p>
      )}
    </div>
  );
}
