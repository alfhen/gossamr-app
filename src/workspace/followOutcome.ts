import type { Backend } from "../backend/types";
import type { RunOutcome } from "../types";

/**
 * Reads a run's outcome now and again whenever its code links or any draft change, so a comment draft that was
 * skipped or posted from its own card stops being offered. Only the newest read counts, so a slow earlier one can't
 * bring back an older state. Returns the unsubscribe.
 */
export function followOutcome(backend: Backend, id: string, onOutcome: (outcome: RunOutcome) => void): () => void {
  let live = true;
  let latest = 0;
  const read = () => {
    const mine = ++latest;
    return backend.runsOutcome(id).then((o) => live && mine === latest && onOutcome(o), () => {});
  };
  void read();
  const offs = [backend.onDevLinksChanged(() => void read()), backend.onProposalsChanged(() => void read())];
  return () => {
    live = false;
    offs.forEach((off) => off());
  };
}
