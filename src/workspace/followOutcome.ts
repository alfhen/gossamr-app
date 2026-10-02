import type { Backend } from "../backend/types";
import type { RunOutcome } from "../types";

/**
 * Reads a run's outcome now and again whenever its code links or any draft change, so a comment draft that was
 * skipped or posted from its own card stops being offered. Returns the unsubscribe.
 */
export function followOutcome(backend: Backend, id: string, onOutcome: (outcome: RunOutcome) => void): () => void {
  let live = true;
  const read = () => backend.runsOutcome(id).then((o) => live && onOutcome(o), () => {});
  void read();
  const offs = [backend.onDevLinksChanged(() => void read()), backend.onProposalsChanged(() => void read())];
  return () => {
    live = false;
    offs.forEach((off) => off());
  };
}
