import { useState } from "react";
import { useBackend } from "../backend/useBackend";
import type { CloneChoice, Run } from "../types";
import { askPipInWorkstream } from "./askPip";
import { homeShort, pipAsks } from "./runSheetLogic";
import { messageOf, useToasts } from "./toasts";
import { Button } from "../components/Button";

/**
 * What an agent that couldn't start for want of a clone offers: clone the repository, or choose one of the clones Gossamr
 * found. Either then asks Pip to start the agent again, since the run itself keeps the folder it was given.
 */
export function CloneActions({ run }: { run: Run }) {
  const backend = useBackend();
  const [choices, setChoices] = useState<CloneChoice | "loading" | null>(null);
  const [busy, setBusy] = useState(false);
  const repo = run.spec.repo;
  const asked = () => void askPipInWorkstream(run, pipAsks.again(run));
  const guarded = async (what: string, act: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await act();
      asked();
    } catch (e) {
      useToasts.getState().push(`${what}. ${messageOf(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => {
    if (choices !== null) return setChoices(null);
    setChoices("loading");
    backend?.runsClones(repo).then(setChoices, () => setChoices(null));
  };
  return (
    <>
      <Button variant="primary" size="sm" data-clone-it disabled={busy} onClick={(ev) => (ev.stopPropagation(), void guarded(`Couldn't clone ${repo}`, async () => backend?.runsCloneFresh(repo)))}>
        Clone it
      </Button>
      <Button size="sm" data-choose-clone aria-expanded={choices !== null} disabled={busy} onClick={(ev) => (ev.stopPropagation(), toggle())}>
        Choose clone
      </Button>
      {choices !== null && (
        <div data-clone-choices className="basis-full">
          {choices === "loading" ? (
            <p className="m-0 text-sm text-ws-ink3">Looking for clones…</p>
          ) : choices.clones.length === 0 ? (
            <p className="m-0 text-sm text-ws-ink3">No clone of {repo} in ~/Code, ~/Developer or ~/src.</p>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0">
              {choices.clones.map((c) => (
                <li key={c.path}>
                  <Button size="sm" data-clone-path={c.path} disabled={busy} onClick={(ev) => (ev.stopPropagation(), void guarded("Couldn't use that clone", async () => backend?.runsPickClone(repo, c.path)))} className="w-full justify-start">
                    <span className="font-mono">{homeShort(c.path)}</span>
                    <span className="text-ws-ink3">
                      on {c.branch}
                      {c.dirty ? ", uncommitted changes" : ""}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
