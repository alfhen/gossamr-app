import { useState } from "react";
import { BUILD_ON_GITHUB } from "./githubSafety";
import { usePrefs } from "./prefs";

/** The first-run orientation on Pip home, in the app's own words for each term. Kept apart so a test can read the copy. */
export const ORIENTATION_TERMS: readonly { term: string; text: string }[] = [
  { term: "Pip", text: "Pip manages your ticket work: it reads your tickets and runs, plans the next step and drafts what to do about it. You decide." },
  { term: "Workstream", text: "One ticket's work from start to pull request. Each has its own conversation with Pip, its steps and its drafts." },
  { term: "Run", text: "One Claude Code agent session doing a step: investigate, plan, build or review." },
  { term: "Cobweb", text: "Work has happened but Jira has not heard for days. Post an update to clear it." },
  { term: "Status", text: "Each workstream's one word: Needs you, Held, Waiting on reporter, Running, Quiet, Done or Idle. Hover a word for what it means." },
  { term: "Intake", text: "The first stage of a workstream, before there is a plan." },
  { term: "Advise", text: "Pip answers when asked and starts nothing." },
  { term: "Manage", text: "Pip is woken when a step finishes and starts the routine next one on its own, within the workstream's allowance. Advise or Hold stops it." },
  { term: "Hold", text: "Stops Pip waking and any automatic step in one workstream until you Resume. Its agents carry on." },
  { term: "Allow once", text: "When an agent asks permission for a command, Allow once opens it in Terminal to confirm there; Deny tells the agent no and it carries on without it. A read-only step can only be denied." },
  { term: "Decide", text: "A draft or a choice waits on you." },
  { term: "Unblock", text: "An agent is stopped until you answer." },
  { term: "Worktree", text: "The run's own checkout of your repository, so runs don't step on each other or on your files." },
];

/** What the app is for, said first: the glossary behind its button only names the words. */
export const ORIENTATION_PURPOSE = "Pip works through your Jira tickets with coding agents and drafts every Jira and GitHub write for you to read and approve; nothing posts until you do.";

export const ORIENTATION_SAFETY = `Gossamr posts only what you approve; a Build runs with your Claude settings and could reach Jira or GitHub on its own. ${BUILD_ON_GITHUB}`;

/** The glossary's button, named apart from the other More buttons on Pip home. */
export const ORIENTATION_WORDS = "What the words mean";

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

/**
 * What Pip home's words mean, until the person says Got it: one line, with the words behind What the words mean (`open` starts it expanded).
 * It never takes focus by itself. `compact` keeps it to its one line, for while Plan my week needs the room; the person's choice to open the words is
 * remembered and comes back with the words.
 */
export function PipOrientation({ onDismiss = dismissOrientation, open = false, compact = false }: { onDismiss?(): void; open?: boolean; compact?: boolean }) {
  const [asked, setMore] = useState(open);
  const more = asked && !compact;
  const button = "rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip";
  return (
    <section data-pip-orientation aria-labelledby="pip-orientation" className="grid max-h-[40vh] shrink-0 gap-1.5 overflow-y-auto border-b border-ws-sep bg-ws-bar px-4 py-1.5">
      <div className="flex items-center gap-3">
        <p className="m-0 min-w-0 flex-1 text-sm text-ws-ink2">
          <b id="pip-orientation" className="font-semibold text-ws-ink">
            New here?
          </b>{" "}
          {ORIENTATION_PURPOSE} {ORIENTATION_SAFETY}
        </p>
        <button type="button" aria-expanded={more} aria-controls="pip-orientation-more" onClick={() => setMore(!more)} className={button}>
          {ORIENTATION_WORDS}
        </button>
        <button type="button" onClick={onDismiss} className={button}>
          Got it
        </button>
      </div>
      {more && (
        <dl id="pip-orientation-more" className="m-0 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4 gap-y-2 text-sm text-ws-ink2">
          {ORIENTATION_TERMS.map((t) => (
            <div key={t.term}>
              <dt className="font-semibold text-ws-ink">{t.term}</dt>
              <dd className="m-0">{t.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
