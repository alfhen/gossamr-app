import type { Notice } from "./useCards";

export function NoticeLine({ notice, onDismiss }: { notice: Notice | null; onDismiss(): void }) {
  return (
    <div role="status" className="min-h-6 px-6 pb-1 text-sm">
      {notice && (
        <p className={notice.tone === "error" ? "text-ws-blocked" : "text-ws-ink2"}>
          {notice.text}{" "}
          <button type="button" onClick={onDismiss} className="text-ws-ink3 underline">
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
