import type { CSSProperties } from "react";
import { useToasts, type Toast } from "./toasts";

/** How far a toast on Pip home rises to clear the composer, its suggestion chips and the line under it. */
export const COMPOSER_CLEAR = 128;

/**
 * Where toasts sit: the bottom right of the canvas, above the footer and stacked over Pip's launcher, left of the peek.
 * Nothing the person navigates by is there: the header, the tabs, the view switcher and the peek's own tabs are all at
 * the top. On Pip home they sit in the Steps column, clear of the Needs you tray on the left and the composer in the
 * middle; with a peek over that column, or below 1100px where it moves under the list, they rise above the composer
 * instead (`--ws-toast-lift` in theme.css). `clearRight` is the width of the peek, when one is open.
 */
export function toastPlacement(screen: string | null, clearRight: number): CSSProperties {
  if (screen === "pip" && !clearRight) return { right: 16, bottom: "calc(var(--ws-footer-h, 2rem) + 0.75rem + var(--ws-toast-lift, 0px))", maxWidth: 288 };
  if (screen === "pip") return { right: `calc(${clearRight}px + 1.25rem)`, bottom: `calc(var(--ws-footer-h, 2rem) + 0.75rem + ${COMPOSER_CLEAR}px)`, maxWidth: `min(420px, calc(100% - ${clearRight}px - 2.5rem))` };
  return {
    right: `calc(${clearRight}px + 1.25rem)`,
    bottom: "calc(var(--ws-footer-h, 2rem) + 0.75rem + var(--ws-launcher-clear, 0px))",
    maxWidth: `min(420px, calc(100% - ${clearRight}px - 2.5rem))`,
  };
}

/** Where the keyboard was before F6 took it to the toast, so dismissing it with Esc gives it back. */
let before: HTMLElement | null = null;

/** F6's stop at the toast on screen: remembers where the keyboard was and puts it on the toast. False when there is none. */
export function focusToast(doc: Pick<Document, "querySelector" | "activeElement"> = document): boolean {
  const el = doc.querySelector<HTMLElement>("[data-toast]");
  if (!el) return false;
  const active = doc.activeElement as HTMLElement | null;
  if (active && typeof active.focus === "function" && !el.contains(active)) before = active;
  el.focus();
  return true;
}

/** Gives the keyboard back to where F6 took it from (when that is still on the page), else to the page's main area. */
function leaveToast() {
  const back = before?.isConnected ? before : typeof document === "undefined" ? null : document.getElementById("workspace-main");
  before = null;
  back?.focus();
}

export function ToastCard({ toast: t, waiting, onDismiss }: { toast: Toast; waiting: number; onDismiss(): void }) {
  return (
    <div
      data-toast
      data-esc-local
      tabIndex={-1}
      aria-keyshortcuts="Escape F6"
      onKeyDown={(ev) => {
        // Esc on the focused toast dismisses it and hands the keyboard back; nothing else takes the key.
        if (ev.key !== "Escape" || ev.defaultPrevented) return;
        ev.preventDefault();
        ev.stopPropagation();
        onDismiss();
        leaveToast();
      }}
      className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-ws-win px-3 py-2 text-sm shadow-ws-pop outline-none focus-visible:outline-2 focus-visible:outline-ws-pip ${t.tone === "error" ? "border-ws-blocked text-ws-blocked" : "border-ws-sep2 text-ws-ink2"}`}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{t.text}</span>
      {waiting > 0 && (
        <span className="shrink-0 rounded-full bg-ws-sel px-1.5 text-xs font-semibold text-ws-ink3" title={`${waiting} more after this one`}>
          +{waiting} more
        </span>
      )}
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action!.run();
            onDismiss();
          }}
          data-toast-action={t.action.label}
          className="shrink-0 font-semibold text-ws-accent underline"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss (Esc when the toast has the keyboard)"
        onClick={() => {
          onDismiss();
          // Reached with F6 then Tab, the button hands the keyboard back as Esc does; a click that never came through F6 leaves focus alone.
          if (before) leaveToast();
        }}
        className="shrink-0 rounded px-1 text-lg leading-none opacity-70 hover:opacity-100">
        ×
      </button>
    </div>
  );
}

/**
 * Errors and notes that don't block anything: one at a time, each going away by itself, the rest waiting. Inside the
 * workspace it is placed with `toastPlacement`; on its own (the first-run picker) it sits bottom right of the window.
 */
export function ToastHost({ placement }: { placement?: CSSProperties }) {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const head = toasts[0];
  return (
    <div
      role="status"
      aria-live="polite"
      data-toast-host={placement ? "canvas" : "window"}
      style={placement ?? { right: 16, bottom: 16 }}
      className={`ws-toasts pointer-events-none z-50 grid w-max max-w-[min(420px,calc(100vw-2rem))] justify-items-end ${placement ? "absolute" : "fixed"}`}
    >
      {head && <ToastCard key={head.id} toast={head} waiting={toasts.length - 1} onDismiss={() => dismiss(head.id)} />}
    </div>
  );
}
