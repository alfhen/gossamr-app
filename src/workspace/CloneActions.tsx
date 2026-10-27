import { useState } from "react";
import { useBackend } from "../backend/useBackend";
import type { CloneChoice, Run } from "../types";
import { askPipInWorkstream } from "./askPip";
import { homeShort, pipAsks } from "./runSheetLogic";
import { messageOf, useToasts } from "./toasts";

const BUTTON = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-px text-sm leading-normal whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45";

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
      <button type="button" data-clone-it disabled={busy} onClick={(ev) => (ev.stopPropagation(), void guarded(`Couldn't clone ${repo}`, async () => backend?.runsCloneFresh(repo)))} className={`${BUTTON} border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:brightness-110`}>
        Clone it
      </button>
      <button type="button" data-choose-clone aria-expanded={choices !== null} disabled={busy} onClick={(ev) => (ev.stopPropagation(), toggle())} className={`${BUTTON} border-ws-sep2 text-ws-ink hover:bg-ws-hover`}>
        Choose clone
      </button>
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
                  <button type="button" data-clone-path={c.path} disabled={busy} onClick={(ev) => (ev.stopPropagation(), void guarded("Couldn't use that clone", async () => backend?.runsPickClone(repo, c.path)))} className={`${BUTTON} w-full justify-start border-ws-sep2 text-ws-ink hover:bg-ws-hover`}>
                    <span className="font-mono">{homeShort(c.path)}</span>
                    <span className="text-ws-ink3">
                      on {c.branch}
                      {c.dirty ? ", uncommitted changes" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
