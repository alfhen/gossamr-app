import { useToasts } from "./toasts";

/** Errors and notes that don't block anything: they stack in a corner and go away by themselves. */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div role="status" aria-live="polite" className="ws-toasts pointer-events-none fixed bottom-4 left-4 z-50 grid max-w-[min(420px,calc(100vw-2rem))] gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-ws-win px-3 py-2 text-sm shadow-ws-pop ${t.tone === "error" ? "border-ws-blocked text-ws-blocked" : "border-ws-sep2 text-ws-ink2"}`}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 rounded px-1 text-lg leading-none opacity-70 hover:opacity-100">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
