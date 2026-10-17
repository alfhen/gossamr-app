import { create } from "zustand";

export type ToastTone = "error" | "info";

/** Names an action's button: "Undo" alone, or "Undo keep waiting" when the toast says what it would undo (`what`). */
export const actionName = (a: { label: string; what?: string }) => (a.what ? `${a.label} ${a.what}` : a.label);

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
   * A note the person may still need to act on, as an Undo: it comes to the front of the notes waiting, ahead of an older offer (an error still goes
   * before it), is never dropped for waiting, and a second one with the same words replaces the first.
   */
  keep?: boolean;
  /** As `ToastOptions.now`: it answers a keypress, so it took the screen from a note rather than waiting behind it. */
  now?: boolean;
  /** As `ToastOptions.spoken`. */
  spoken?: false;
}

export interface ToastOptions {
  /** As `Toast.current`. */
  current?: () => boolean;
  /** As `Toast.lifetime`. */
  lifetime?: number;
  /** As `Toast.keep`. */
  keep?: boolean;
  /**
   * The note answers a key the person just pressed (Ctrl+0 is off): it takes the screen at once instead of queuing as "+1 more"
   * behind a note that is about something else, which it replaces. It never takes the screen from an error or an offer to
   * undo; it goes next to the head then, ahead of the notes waiting.
   */
  now?: boolean;
  /** `false` when a line beside the toast already says it to a screen reader (the pane's "Skipped: …"): its live region stays empty, so it is not announced twice. */
  spoken?: false;
}

export interface ToastAction {
  label: string;
  /** What the button would undo, in a few words ("keep waiting"): the button reads "Undo keep waiting", so a toast waiting behind another says which one it is. */
  what?: string;
  run(): void;
}

/** What holds a toast still: the pointer moving on it, or the keyboard on it. Each lets go on its own. */
export type ToastHold = "pointer" | "focus";

interface ToastState {
  /** Only the head is on screen; the rest wait their turn, errors ahead of notes, each kind oldest first. */
  toasts: Toast[];
  /** Returns the new toast's id, or null when the same words are already waiting. */
  push(text: string, tone?: ToastTone, action?: ToastAction, options?: ToastOptions): number | null;
  dismiss(id: number): void;
  /** Stops the shown toast's clock while the pointer or the keyboard (`by`) is on it, so it is not taken away mid-read. */
  hold(id: number, by?: ToastHold): void;
  /** Lets go of one hold; once neither the pointer nor the keyboard holds it, its clock starts again, for its whole lifetime. */
  release(id: number, by?: ToastHold): void;
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
let timed: { id: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
/** The toast the pointer or keyboard is on, and which of them: its clock does not run while either does. */
let held: { id: number; by: Set<ToastHold> } | null = null;

/** Whether a note's subject is still as it said; a check that throws counts as moved on. */
function stillNews(t: Toast): boolean {
  try {
    return t.current?.() ?? true;
  } catch {
    return false;
  }
}

/** Lets every toast that was kept out of the live region speak after all: the line that was to say it (the pane's "Skipped: …") has nothing to say, as the skipped draft was the last need. */
export const speakQuietToasts = () => {
  if (useToasts.getState().toasts.some((t) => t.spoken === false)) useToasts.setState((s) => ({ toasts: s.toasts.map((t) => (t.spoken === false ? { ...t, spoken: undefined } : t)) }));
};

export const useToasts = create<ToastState>((set, get) => {
  /** Starts the clock of whichever toast is now at the head, once, after dropping notes that waited too long to come up. */
  const arm = () => {
    const now = Date.now();
    const fresh = (t: Toast) => t.id === timed?.id || t.tone === "error" || t.keep || (now - t.at <= STALE_MS && stillNews(t));
    if (!get().toasts.every(fresh)) set((s) => ({ toasts: s.toasts.filter(fresh) }));
    const head = get().toasts[0];
    if (timed && timed.id === head?.id) return;
    if (timed?.timer) clearTimeout(timed.timer);
    timed = head ? { id: head.id, timer: head.id === held?.id ? null : setTimeout(() => get().dismiss(head.id), head.lifetime ?? LIFETIME_MS[head.tone]) } : null;
  };
  return {
    toasts: [],

    push(text, tone = "error", action, options) {
      const keep = !!options?.keep;
      const now = !!options?.now;
      if (!keep && get().toasts.some((t) => t.text === text)) return null;
      const id = ++seq;
      set((s) => {
        const toast: Toast = { id, text, tone, action, at: Date.now(), current: options?.current, lifetime: options?.lifetime, keep, now, ...(options?.spoken === false ? { spoken: false as const } : {}) };
        // The same offer again (a second Hold of the same workstream) replaces the one before it, on screen or waiting (an error on screen stays).
        const queue = keep ? s.toasts.filter((t, i) => (i === 0 && t.tone === "error") || t.text !== text) : s.toasts;
        // An error goes ahead of the notes waiting, behind the one on screen and any errors before it. An offer to undo goes
        // to the front: it is a few seconds long, and what it undoes is what the person just did. It takes the screen from a
        // note or an older offer (which waits behind it, still reachable), never from an error, which it queues behind.
        const head = queue[0];
        if (now && !keep) {
          // A note on screen gives way; an error or an offer stays, and the answer comes right behind it.
          const yields = !head || (head.tone !== "error" && !head.keep);
          // Errors and offers already waiting still come first; the answer goes ahead of the ordinary notes.
          const rest = yields ? queue.slice(1) : queue;
          const from = yields ? 0 : 1;
          const at = rest.findIndex((t, i) => i >= from && t.tone === "info" && !t.keep);
          return { toasts: at < 0 ? [...rest, toast] : [...rest.slice(0, at), toast, ...rest.slice(at)] };
        }
        const front = keep && (!head || head.tone !== "error");
        const at = tone === "error" ? queue.findIndex((t, i) => i > 0 && t.tone === "info") : -1;
        // Behind errors, an offer still comes ahead of an older offer: the first one up is always the newest action's.
        const past = keep && !front ? queue.findIndex((t) => t.tone !== "error") : -1;
        const toasts = front ? [toast, ...queue] : keep ? (past < 0 ? [...queue, toast] : [...queue.slice(0, past), toast, ...queue.slice(past)]) : at > 0 ? [...queue.slice(0, at), toast, ...queue.slice(at)] : [...queue, toast];
        if (toasts.length <= MAX_QUEUED) return { toasts };
        // Over the cap, the oldest note waiting gives way, or with none waiting the oldest error.
        const note = toasts.findIndex((t, i) => i > 0 && t.tone === "info");
        const drop = note > 0 ? note : 1;
        return { toasts: [...toasts.slice(0, drop), ...toasts.slice(drop + 1)] };
      });
      arm();
      return id;
    },

    dismiss(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      arm();
    },
    hold(id, by = "pointer") {
      held = held?.id === id ? { id, by: new Set([...held.by, by]) } : { id, by: new Set([by]) };
      if (timed?.id !== id || !timed.timer) return;
      clearTimeout(timed.timer);
      timed = { id, timer: null };
    },
    release(id, by = "pointer") {
      if (held?.id !== id) return;
      held.by.delete(by);
      if (held.by.size > 0) return;
      held = null;
      const head = get().toasts[0];
      if (!head || head.id !== id || timed?.timer) return;
      timed = { id, timer: setTimeout(() => get().dismiss(id), head.lifetime ?? LIFETIME_MS[head.tone]) };
    },
    clear() {
      set({ toasts: [] });
      arm();
    },
  };
});

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

/** The notes about what Looks fine taught, and the projects each is about: only the newest of them is worth showing. */
const learning = new Map<number, readonly string[]>();

/** Takes down the learning notes (on screen or waiting) about any of these projects: what they said is no longer so. */
export function retireLearning(projects: readonly string[]) {
  for (const [id, about] of [...learning]) {
    if (!about.some((p) => projects.includes(p))) continue;
    learning.delete(id);
    useToasts.getState().dismiss(id);
  }
}

/**
 * A note about what Looks fine taught in a project, or in several at once (giving back every project's learning): it replaces
 * an older one about any of them, on screen or waiting, and a newer note about any of them replaces it, so the newest says what stands.
 */
export function pushLearning(projects: string | readonly string[], text: string, current?: () => boolean): number | null {
  const about = typeof projects === "string" ? [projects] : [...projects];
  retireLearning(about);
  const id = useToasts.getState().push(text, "info", undefined, { current });
  if (id !== null) learning.set(id, about);
  return id;
}
