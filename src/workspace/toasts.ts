import { create } from "zustand";

export type ToastTone = "error" | "info";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
  /** When it was pushed (Date.now()), so a note that waited too long behind others is dropped instead of shown late. */
  at: number;
  /**
   * Whether a note is still news: "Agent started on CA-402" is not once that run has finished. Asked when the note would
   * come up; a note whose subject has moved on is dropped, never shown.
   */
  current?: () => boolean;
  /** How long it stays once on screen, when not the tone's (`LIFETIME_MS`). An Undo offer stays `UNDO_LIFETIME_MS`. */
  lifetime?: number;
  /**
   * A note the person may still need to act on, as an Undo: it comes to the front of the notes waiting (an error still goes
   * before it), is never dropped for waiting, and a second one with the same words replaces the first.
   */
  keep?: boolean;
}

export interface ToastOptions {
  /** As `Toast.current`. */
  current?: () => boolean;
  /** As `Toast.lifetime`. */
  lifetime?: number;
  /** As `Toast.keep`. */
  keep?: boolean;
}

export interface ToastAction {
  label: string;
  run(): void;
}

interface ToastState {
  /** Only the head is on screen; the rest wait their turn, errors ahead of notes, each kind oldest first. */
  toasts: Toast[];
  push(text: string, tone?: ToastTone, action?: ToastAction, options?: ToastOptions): void;
  dismiss(id: number): void;
  clear(): void;
}

/** How long a toast stays once it is the one on screen. Errors stay longer, and keep their Dismiss button. */
export const LIFETIME_MS: Record<ToastTone, number> = { info: 5000, error: 12000 };
/** How long a note that offers Undo stays: long enough to read it and reach for the button, short enough not to linger. */
export const UNDO_LIFETIME_MS = 8000;
/**
 * A note still waiting this long after it was pushed is out of date: it is dropped, never shown. So is one whose subject
 * has moved on (`Toast.current`), however short its wait. Errors always wait their turn.
 */
export const STALE_MS = 4000;
/** Past this many, the oldest note waiting gives way (an error only when no note waits); the one on screen stays. */
export const MAX_QUEUED = 10;
let seq = 0;
/** The toast whose clock is running, and its timer: only the shown one counts down. */
let timed: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;

/** Whether a note's subject is still as it said; a check that throws counts as moved on. */
function stillNews(t: Toast): boolean {
  try {
    return t.current?.() ?? true;
  } catch {
    return false;
  }
}

export const useToasts = create<ToastState>((set, get) => {
  /** Starts the clock of whichever toast is now at the head, once, after dropping notes that waited too long to come up. */
  const arm = () => {
    const now = Date.now();
    const fresh = (t: Toast) => t.id === timed?.id || t.tone === "error" || t.keep || (now - t.at <= STALE_MS && stillNews(t));
    if (!get().toasts.every(fresh)) set((s) => ({ toasts: s.toasts.filter(fresh) }));
    const head = get().toasts[0];
    if (timed && timed.id === head?.id) return;
    if (timed) clearTimeout(timed.timer);
    timed = head ? { id: head.id, timer: setTimeout(() => get().dismiss(head.id), head.lifetime ?? LIFETIME_MS[head.tone]) } : null;
  };
  return {
    toasts: [],

    push(text, tone = "error", action, options) {
      const keep = !!options?.keep;
      if (!keep && get().toasts.some((t) => t.text === text)) return;
      const id = ++seq;
      set((s) => {
        const toast: Toast = { id, text, tone, action, at: Date.now(), current: options?.current, lifetime: options?.lifetime, keep };
        // The same offer again (a second Hold of the same workstream) replaces the one waiting; the one on screen stays.
        const queue = keep ? s.toasts.filter((t, i) => i === 0 || t.text !== text) : s.toasts;
        // An error goes ahead of the notes waiting, behind the one on screen and any errors before it. An offer to undo goes
        // to the front: it is a few seconds long, and what it undoes is what the person just did. It takes the screen from a
        // note, never from an error or another offer, which it queues behind.
        const head = queue[0];
        const front = keep && (!head || (head.tone !== "error" && !head.keep));
        const at = tone === "error" ? queue.findIndex((t, i) => i > 0 && t.tone === "info") : -1;
        const toasts = front ? [toast, ...queue] : at > 0 ? [...queue.slice(0, at), toast, ...queue.slice(at)] : [...queue, toast];
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
