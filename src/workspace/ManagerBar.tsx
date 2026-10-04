import { useEffect, useState } from "react";
import { LAST_STEP, STEPS } from "./managerScenario";
import { nextStep, resetScenario } from "./managerLive";
import { useManager } from "./managerProto";

const BUTTON = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm font-semibold hover:bg-ws-hover disabled:opacity-45";

/** Keeps the story walkable from the keyboard: Alt+Right for the next step, Alt+Shift+R to reset. */
function useScenarioKeys() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.altKey || ev.metaKey || ev.ctrlKey) return;
      if (ev.code === "ArrowRight" && !ev.shiftKey) {
        ev.preventDefault();
        void nextStep();
      } else if (ev.code === "KeyR" && ev.shiftKey) {
        ev.preventDefault();
        resetScenario();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Shown only in the prototype: where the story stands, and the buttons that move it. Fixed to the window so it stays whole however narrow the screen. */
export function ManagerBar() {
  const step = useManager((s) => s.step);
  const busy = useManager((s) => s.busy);
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);
  useScenarioKeys();
  const here = STEPS[step];
  const done = step >= LAST_STEP;
  return (
    <section aria-label="Prototype scenario" className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex justify-center">
      <div className="pointer-events-auto grid w-full max-w-[760px] gap-1.5 rounded-xl border border-ws-pip bg-ws-win px-3 py-2 shadow-ws-pop">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="rounded-full bg-ws-pip px-2 text-xs font-bold tracking-[0.04em] text-ws-on-pip uppercase">Prototype</span>
          <b className="font-semibold">Pip as manager</b>
          <span aria-hidden className="hidden items-center gap-1 sm:flex">
            {STEPS.map((_, i) => (
              <i key={i} className={`size-1.5 rounded-full ${i < step ? "bg-ws-pip" : i === step ? "bg-ws-pip ring-2 ring-ws-pip-soft" : "bg-ws-sep2"}`} />
            ))}
          </span>
          <span className="text-sm text-ws-ink3">
            Step {step} of {LAST_STEP}
            {open ? `: ${here.title}` : ""}
          </span>
          <span className="flex-1" />
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide the description" : "Show the description"} className={BUTTON}>
            {open ? "Hide" : "Show"}
          </button>
          <button type="button" onClick={resetScenario} title="Alt+Shift+R" className={BUTTON}>
            Reset
          </button>
          <button
            type="button"
            disabled={busy || done}
            onClick={() => void nextStep()}
            title="Alt+Right"
            className="rounded-md bg-ws-pip px-3 py-1 text-sm font-semibold text-ws-on-pip disabled:opacity-45"
          >
            {busy ? "Playing…" : done ? "The end" : open ? `Next: ${STEPS[step + 1].title}` : "Next"}
          </button>
        </div>
        {open && (
          <p aria-live="polite" className="m-0 text-sm text-ws-ink2">
            {here.caption}
          </p>
        )}
      </div>
    </section>
  );
}
