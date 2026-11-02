import { useState } from "react";
import type { Run } from "../types";
import { askPipInWorkstream } from "./askPip";
import { pipAsks } from "./runSheetLogic";
import { messageOf, useToasts } from "./toasts";
import { Button } from "../components/Button";

/** What a run set up outside Gossamr's work folder offers: Pip starts the agent again, and it works in Gossamr's own clone. */
export function CloneActions({ run }: { run: Run }) {
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    try {
      await askPipInWorkstream(run, pipAsks.again(run));
    } catch (e) {
      useToasts.getState().push(`Couldn't ask Pip. ${messageOf(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="primary" size="sm" data-ask-pip-again disabled={busy} onClick={(ev) => (ev.stopPropagation(), void ask())}>
      Ask Pip to start it again
    </Button>
  );
}
