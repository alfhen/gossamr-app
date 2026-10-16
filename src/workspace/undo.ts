import { UNDO_LIFETIME_MS, messageOf, useToasts } from "./toasts";

/**
 * Undo for the reversible actions: the action has already happened, a toast says so and offers Undo for a few seconds, and
 * Undo puts back exactly what was there. Nothing here decides what is reversible: the places that act (skip a draft,
 * dismiss a run, hold, Advise) offer it, and anything that reaches Jira, GitHub or an agent never does.
 *
 * An offer is good for `UNDO_VALID_MS`, longer than its toast, so the palette's "Undo" still reaches it after the toast
 * has gone; the backend's own window (`UNSKIP_WINDOW_SECS`, `UNDO_WINDOW_SECS`: 60 s) refuses anything older either way.
 */
export const UNDO_VALID_MS = 60_000;
/** How many offers are kept to look at; the oldest go. */
const KEPT = 20;

/** What an action offers: the words, and the one thing that puts it back. */
export interface UndoOffer {
  /** What happened, as the toast says it: "Skipped the draft on CA-401." */
  text: string;
  /** What the toast says once undone; "Undone." when not given. */
  undone?: string;
  /** Puts it back. Rejects (or resolves false) when it can't: the offer is then spent and the person told. */
  undo(): Promise<boolean | void>;
  /** Runs once it is back, to show the person what came back (open the restored draft); its failure is not the undo's. */
  restored?(): void;
  /** Runs once it is back, to put the keyboard where the person was working: the toast's Undo took it away with the toast. */
  refocus?(): void;
}

/** An offer's life: offered, being undone, then one of the ends; "withdrawn" is when the person did something else that makes it moot (Resume after Hold). */
export type UndoState = "offered" | "undoing" | "undone" | "failed" | "expired" | "withdrawn";

export interface UndoEntry {
  id: number;
  text: string;
  at: number;
  state: UndoState;
}

/** What asking for an undo came to: it was done, it was too late or already used, or it failed (and the person was told why). */
export type UndoResult = "undone" | "expired" | "spent" | "failed";

/** The log of offers, with an injectable clock and a way to tell the person; the app's is `undoLog`. */
export class UndoLog {
  private entries: (UndoEntry & { offer: UndoOffer })[] = [];
  private seq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly tell: (text: string, tone: "info" | "error") => void = () => {},
    private readonly valid: number = UNDO_VALID_MS,
    /** Called once when offer `id` is no longer on offer (being undone, or too late), so what showed it can go. */
    private readonly settled: (id: number) => void = () => {},
  ) {}

  /** Records an offer, newest last; returns its id. */
  offer(offer: UndoOffer): number {
    const id = ++this.seq;
    this.entries.push({ id, text: offer.text, at: this.now(), state: "offered", offer });
    if (this.entries.length > KEPT) this.entries.splice(0, this.entries.length - KEPT);
    return id;
  }

  /** The offer `id` as it stands now; an offer that has been good too long reads as expired. */
  get(id: number): UndoEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    if (e.state === "offered" && this.now() - e.at > this.valid) e.state = "expired";
    return { id: e.id, text: e.text, at: e.at, state: e.state };
  }

  /** The newest offer still good, for the palette's "Undo". */
  latest(): UndoEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.get(this.entries[i].id);
      if (e?.state === "offered") return e;
    }
    return null;
  }

  /** Undoes offer `id`, once: a second ask, or one after it expired, does nothing and says so. */
  async run(id: number): Promise<UndoResult> {
    const state = this.get(id)?.state;
    const entry = this.entries.find((x) => x.id === id);
    if (!entry || !state) return "spent";
    if (state === "expired") {
      this.settled(id);
      this.tell("Too late to undo that.", "info");
      return "expired";
    }
    if (state !== "offered") return "spent";
    entry.state = "undoing";
    this.settled(id);
    try {
      const done = await entry.offer.undo();
      if (done === false) throw new Error("it has changed since");
      entry.state = "undone";
      try {
        entry.offer.restored?.();
      } catch {
        // Showing it is a courtesy: the undo stands.
      }
      try {
        entry.offer.refocus?.();
      } catch {
        // As above.
      }
      this.tell(entry.offer.undone ?? "Undone.", "info");
      return "undone";
    } catch (e) {
      entry.state = "failed";
      this.tell(`Couldn't undo that. ${messageOf(e)}`, "error");
      return "failed";
    }
  }

  /** Takes offer `id` back when what it would undo has been settled another way: it is spent, and what showed it goes. No-op once it is no longer on offer. */
  withdraw(id: number) {
    const entry = this.entries.find((x) => x.id === id);
    if (!entry || entry.state !== "offered") return;
    entry.state = "withdrawn";
    this.settled(id);
  }

  /** Forgets every offer, as when another account is shown. */
  clear() {
    this.entries = [];
  }
}

/** The toast offering each undo, so running the undo from the palette takes the toast down too. */
const toastOf = new Map<number, number>();

export const undoLog = new UndoLog(
  Date.now,
  (text, tone) => void useToasts.getState().push(text, tone),
  UNDO_VALID_MS,
  (id) => {
    const toast = toastOf.get(id);
    if (toast === undefined) return;
    toastOf.delete(id);
    useToasts.getState().dismiss(toast);
  },
);

/**
 * Tells the person what they just did, with an Undo button for about 8 seconds. The offer outlives the toast (`UNDO_VALID_MS`)
 * for the palette's "Undo".
 */
export function offerUndo(offer: UndoOffer): number {
  const id = undoLog.offer(offer);
  const toast = useToasts.getState().push(offer.text, "info", { label: "Undo", run: () => void undoLog.run(id) }, { lifetime: UNDO_LIFETIME_MS, keep: true });
  if (toast !== null) toastOf.set(id, toast);
  return id;
}

/** Takes the toast of offer `id` down while the offer stays good for the palette's "Undo" (a newer offer for the same kind of thing is the one to show). */
export const hideUndoToast = (id: number | undefined) => {
  const toast = id === undefined ? undefined : toastOf.get(id);
  if (toast === undefined || id === undefined) return;
  toastOf.delete(id);
  useToasts.getState().dismiss(toast);
};

/** Withdraws offer `id` (see `UndoLog.withdraw`), taking its toast down. */
export const withdrawUndo = (id: number | undefined) => {
  if (id !== undefined) undoLog.withdraw(id);
};
