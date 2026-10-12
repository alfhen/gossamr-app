import { usePrefs } from "./prefs";

/** The first-run orientation on Pip home, in the app's own words for each term. Kept apart so a test can read the copy. */
export const ORIENTATION_TERMS: readonly { term: string; text: string }[] = [
  { term: "Pip", text: "Pip manages your ticket work: it reads your tickets and runs, plans the next step and drafts what to do about it. You decide." },
  { term: "Workstream", text: "One ticket's work from start to pull request. Each has its own conversation with Pip, its steps and its drafts." },
  { term: "Run", text: "One Claude Code agent session doing a step: investigate, plan, build or review." },
  { term: "Worktree", text: "The run's own checkout of your repository, so runs don't step on each other or on your files." },
];

export const ORIENTATION_SAFETY = "Nothing is posted to Jira or GitHub until you click to approve it.";

/** Where focus goes when the card closes from its button, so the keyboard stays on Pip home: the list's current row. */
function focusList() {
  document.querySelector<HTMLElement>('[data-pip-home-column="list"] [role="option"][tabindex="0"]')?.focus();
}

/** Marks the card seen, the way the Agents intro is (`agentsIntroSeen`), and keeps the keyboard where it was. */
export function dismissOrientation() {
  const hadFocus = typeof document !== "undefined" && document.activeElement?.closest("[data-pip-orientation]") != null;
  usePrefs.getState().setPipOrientationSeen(true);
  if (hadFocus) requestAnimationFrame(focusList);
}

/** What Pip home's words mean, until the person says Got it. It never takes focus by itself. */
export function PipOrientation({ onDismiss = dismissOrientation }: { onDismiss?(): void }) {
  return (
    <section data-pip-orientation aria-labelledby="pip-orientation" className="grid max-h-[40vh] shrink-0 gap-2 overflow-y-auto border-b border-ws-sep bg-ws-bar px-4 py-3">
      <h2 id="pip-orientation" className="m-0 text-sm font-semibold">
        New here? What these words mean
      </h2>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4 gap-y-2 text-sm text-ws-ink2">
        {ORIENTATION_TERMS.map((t) => (
          <div key={t.term}>
            <dt className="font-semibold text-ws-ink">{t.term}</dt>
            <dd className="m-0">{t.text}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 text-sm text-ws-ink2">{ORIENTATION_SAFETY}</p>
        <button type="button" onClick={onDismiss} className="ml-auto rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
          Got it
        </button>
      </div>
    </section>
  );
}
