import type { ReactNode } from "react";
import { Icon, type IconName } from "./AgentIcons";

const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover";

function Explain({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1.5 rounded-[10px] border border-ws-sep bg-ws-win p-3.5">
      <span aria-hidden className="grid size-[30px] place-items-center rounded-lg bg-ws-pip-soft text-ws-pip">
        <Icon name={icon} className="size-4" />
      </span>
      <h3 className="m-0 text-[13.5px] font-semibold">{title}</h3>
      <p className="m-0 text-ws-ink2">{children}</p>
    </div>
  );
}

/** The first-run explainer. What it says about safety is what the plan requires the interface to say. */
export function AgentsIntro({ onDismiss }: { onDismiss(): void }) {
  return (
    <section aria-labelledby="agents-intro" className="grid gap-3.5 rounded-xl border border-ws-sep bg-ws-bar px-5 py-5">
      <div>
        <span className="inline-flex items-center gap-1 rounded-full bg-ws-pip-soft px-2 text-xs leading-[1.6] font-semibold text-ws-pip">
          <Icon name="spark" className="size-[11px]" />
          New
        </span>
      </div>
      <h2 id="agents-intro" className="m-0 max-w-[56ch] text-xl leading-tight font-semibold text-balance">
        Agents are Claude Code sessions that work in the background
      </h2>
      <p className="m-0 max-w-[62ch] text-ws-ink2">You approve each one first. Agents are on by default; turn them off any time in Settings.</p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
        <Explain icon="term" title="They run as you">
          They run as you, with your own Claude settings: anything your Claude can do, they can do.
        </Explain>
        <Explain icon="shield" title="Told, not locked">
          They are told not to write to Jira and to send findings back to you, but that is a request, not a lock.
        </Explain>
        <Explain icon="branch" title="Where they work">
          They work in their own worktree of your clone, so your own files and branch are not touched.
        </Explain>
        <Explain icon="stop" title="Stopping and finding them">
          Stop any run from its details, or Stop all above. Agents you start from Terminal are not shown here, and Gossamr&apos;s runs also show in your own <code className="font-mono">claude agents</code>.
        </Explain>
      </div>
      <div>
        <button type="button" onClick={onDismiss} className={BUTTON}>
          Got it
        </button>
      </div>
    </section>
  );
}

export function AgentsEmpty() {
  return (
    <div className="mx-auto grid max-w-[560px] justify-items-center gap-2.5 px-5 py-14 text-center">
      <Icon name="term" className="size-16 stroke-[1.2] text-ws-ink3" />
      <h2 className="m-0 text-lg font-semibold">No agents yet</h2>
      <p className="m-0 text-balance text-ws-ink2">When you start one it appears here, and Gossamr tells you when it needs you or finishes. Nothing runs until you approve it.</p>
    </div>
  );
}

export function NoMatch({ hidden, onClear }: { hidden: number; onClear(): void }) {
  return (
    <div className="mx-auto grid max-w-[560px] justify-items-center gap-2.5 px-5 py-14 text-center">
      <Icon name="funnel" className="size-16 stroke-[1.2] text-ws-ink3" />
      <h2 className="m-0 text-lg font-semibold">No agents match these filters</h2>
      <p className="m-0 text-ws-ink2">
        {hidden} {hidden === 1 ? "run is" : "runs are"} hidden by the filters above.
      </p>
      <button type="button" onClick={onClear} className={BUTTON}>
        Clear filters
      </button>
    </div>
  );
}
