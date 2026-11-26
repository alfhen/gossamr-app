import { useEffect, useState } from "react";
import type { Run } from "../types";
import { Box, BoxTitle, Btn, CodeBox } from "./AgentSheet";
import { useRuns } from "./runsStore";

/** What a run handed over to Terminal offers in its sheet. */
export const HANDED_OVER_TEXT = "It is yours in Terminal now. Gossamr sends it no message until you resume it here.";
export const RESUME_ASK = "Did you quit it in Terminal? Gossamr starts it again here, and it can't work in both at once.";

/**
 * A run handed over to Terminal: the provider's own resume command, to copy, Open in Terminal again, and Resume here,
 * which asks first whether you took it back.
 */
export function HandedOverBox({ run, onAttach }: { run: Run; onAttach(): void }) {
  const backend = useRuns((s) => s.backend);
  const [command, setCommand] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setCommand(null);
    backend?.runsResumeCommand(run.id).then(
      (line) => live && setCommand(line),
      () => live && setCommand(null),
    );
    return () => void (live = false);
  }, [backend, run.id]);
  const resume = async () => {
    setBusy(true);
    await useRuns.getState().takeBack(run.id);
    setBusy(false);
    setAsking(false);
  };
  return (
    <Box label="Handed over to Terminal">
      <BoxTitle icon="term" tone="plain">
        Handed over to Terminal
      </BoxTitle>
      <p className="m-0 text-sm text-ws-ink2">{HANDED_OVER_TEXT}</p>
      {command && <CodeBox text={command} what="the command" wrap />}
      {asking ? (
        <div role="group" aria-label="Resume here" className="grid gap-2">
          <p className="m-0 text-sm text-ws-ink">{RESUME_ASK}</p>
          <div className="flex flex-wrap gap-2">
            <Btn tone="primary" icon="play" disabled={busy} onClick={() => void resume()}>
              {busy ? "Resuming…" : "Yes, resume here"}
            </Btn>
            <Btn disabled={busy} onClick={() => setAsking(false)}>
              Not yet
            </Btn>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Btn tone="primary" icon="play" onClick={() => setAsking(true)}>
            Resume here
          </Btn>
          <Btn icon="term" onClick={onAttach}>
            Open in Terminal
          </Btn>
        </div>
      )}
    </Box>
  );
}
