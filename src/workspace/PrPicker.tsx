import { useEffect, useRef, useState } from "react";
import type { RunReview } from "../types";
import { Sec } from "./AgentSheet";
import type { PrSearch } from "./runSetupStore";

export interface PrPickerProps {
  repo: string;
  pr: number | null;
  review: Pick<RunReview, "prTitle" | "prUrl"> | null;
  prs: PrSearch;
  /** What the search box starts with: the ticket's key. */
  initialQuery: string;
  disabled: boolean;
  onSearch(query: string): void;
  onChoose(number: number): void;
}

/** Finds the pull request a review reads. Only an open pull request from the same repository can be chosen; the others say why not. */
export function PrPicker({ repo, pr, review, prs, initialQuery, disabled, onSearch, onChoose }: PrPickerProps) {
  const [query, setQuery] = useState(initialQuery);
  // The search writes to the store, which re-renders the sheet with a new `onSearch`; depending on it would search again and again.
  const search = useRef(onSearch);
  search.current = onSearch;
  useEffect(() => {
    const timer = setTimeout(() => search.current(query), query === initialQuery ? 0 : 250);
    return () => clearTimeout(timer);
  }, [query, initialQuery]);
  const listed = prs.choices.some((c) => c.change.number === pr);
  return (
    <Sec title="Pull request to review">
      <div className="grid gap-2">
        <input aria-label="Find a pull request" value={query} placeholder={`Title, branch or ticket key in ${repo}`} onChange={(ev) => setQuery(ev.target.value)} className="w-full rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink outline-offset-2" />
        {prs.status === "loading" && <p role="status" className="m-0 text-ws-ink3">Searching {repo}…</p>}
        {prs.status === "failed" && (
          <p role="alert" className="m-0 text-ws-blocked [overflow-wrap:anywhere]">
            Couldn&apos;t search for pull requests: {prs.error}
          </p>
        )}
        {prs.status === "idle" && <p className="m-0 text-ws-ink3">Type a title, a branch or a ticket key to find the pull request.</p>}
        {prs.status === "ready" && prs.choices.length === 0 && <p className="m-0 text-ws-ink3">No pull request in {repo} matches &quot;{prs.query}&quot;.</p>}
        {pr !== null && !listed && (
          <p className="m-0 text-ws-ink2">
            Chosen: <span className="font-mono">#{pr}</span> {review?.prTitle}
          </p>
        )}
        {prs.choices.length > 0 && (
          <div role="radiogroup" aria-label="Pull request to review" className="grid gap-1.5">
            {prs.choices.map(({ change, selectable, note }) => {
              const on = change.number === pr;
              return (
                <button
                  key={change.externalId}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={disabled || !selectable}
                  onClick={() => !on && onChoose(change.number!)}
                  className={`grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2 rounded-[9px] border px-2.5 py-2 text-left disabled:cursor-not-allowed ${on ? "border-ws-accent bg-ws-accent-soft" : "border-ws-sep bg-ws-win hover:bg-ws-hover"} ${selectable ? "" : "opacity-60"}`}
                >
                  <span aria-hidden className={`mt-0.5 grid size-3.5 place-items-center rounded-full border-[1.5px] ${on ? "border-ws-accent" : "border-ws-ink3"}`}>
                    {on && <span className="size-1.5 rounded-full bg-ws-accent" />}
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate text-ws-ink">
                      <span className="font-mono text-ws-ink2">#{change.number}</span> {change.title}
                    </span>
                    <span className="truncate font-mono text-xs text-ws-ink3">
                      {change.headRef}
                      {change.baseRef ? ` → ${change.baseRef}` : ""}
                    </span>
                  </span>
                  {note && <span className={`self-start text-xs ${selectable ? "text-ws-ink3" : "font-semibold text-ws-warn"}`}>{note}</span>}
                </button>
              );
            })}
          </div>
        )}
        <p className="m-0 text-xs text-ws-ink3">Only open pull requests from {repo} itself. A fork&apos;s code would run with your settings, so Gossamr doesn&apos;t allow that yet.</p>
      </div>
    </Sec>
  );
}
