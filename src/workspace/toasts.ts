import { create } from "zustand";

export type ToastTone = "error" | "info";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
  /** When it was pushed (Date.now()), so a note that waited too long behind others is dropped instead of shown late. */
  at: number;
}

export interface ToastAction {
  label: string;
  run(): void;
}

interface ToastState {
  /** Only the head is on screen; the rest wait their turn, errors ahead of notes, each kind oldest first. */
  toasts: Toast[];
  push(text: string, tone?: ToastTone, action?: ToastAction): void;
  dismiss(id: number): void;
  clear(): void;
}

/** How long a toast stays once it is the one on screen. Errors stay longer, and keep their Dismiss button. */
export const LIFETIME_MS: Record<ToastTone, number> = { info: 5000, error: 12000 };
/** A note still waiting this long after it was pushed is out of date ("Agent started" once the run is done): it is dropped, never shown. Errors always wait their turn. */
export const STALE_MS = 4000;
/** Past this many, the oldest note waiting gives way (an error only when no note waits); the one on screen stays. */
export const MAX_QUEUED = 10;
let seq = 0;
/** The toast whose clock is running, and its timer: only the shown one counts down. */
let timed: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;

export const useToasts = create<ToastState>((set, get) => {
  /** Starts the clock of whichever toast is now at the head, once, after dropping notes that waited too long to come up. */
  const arm = () => {
    const now = Date.now();
    const fresh = (t: Toast) => t.id === timed?.id || t.tone === "error" || now - t.at <= STALE_MS;
    if (!get().toasts.every(fresh)) set((s) => ({ toasts: s.toasts.filter(fresh) }));
    const head = get().toasts[0];
    if (timed && timed.id === head?.id) return;
    if (timed) clearTimeout(timed.timer);
    timed = head ? { id: head.id, timer: setTimeout(() => get().dismiss(head.id), LIFETIME_MS[head.tone]) } : null;
  };
  return {
    toasts: [],

    push(text, tone = "error", action) {
      if (get().toasts.some((t) => t.text === text)) return;
      const id = ++seq;
      set((s) => {
        const toast = { id, text, tone, action, at: Date.now() };
        // An error goes ahead of the notes waiting, behind the one on screen and any errors before it.
        const at = tone === "error" ? s.toasts.findIndex((t, i) => i > 0 && t.tone === "info") : -1;
        const toasts = at > 0 ? [...s.toasts.slice(0, at), toast, ...s.toasts.slice(at)] : [...s.toasts, toast];
        if (toasts.length <= MAX_QUEUED) return { toasts };
        // Over the cap, the oldest note waiting gives way, or with none waiting the oldest error.
        const note = toasts.findIndex((t, i) => i > 0 && t.tone === "info");
        const drop = note > 0 ? note : 1;
        return { toasts: [...toasts.slice(0, drop), ...toasts.slice(drop + 1)] };
      });
      arm();
    },

    dismiss(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      arm();
    },
    clear() {
      set({ toasts: [] });
      arm();
    },
  };
});

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));
