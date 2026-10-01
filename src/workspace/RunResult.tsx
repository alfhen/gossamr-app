import { useState } from "react";
import type { CodeChange, Run, RunOutcome } from "../types";
import { Box, Btn, CopyButton, Details, Sec } from "./AgentSheet";
import { blockerChoices, blockerControl, changeSummary, commentControl } from "./runSheetLogic";

export interface ResultActions {
  draftComment(): void;
  draftWithPip(): void;
  pickBlocker(): void;
  cancelBlocker(): void;
  draftBlocker(key: string): void;
  openChange(url: string): void;
}

export interface ResultProps {
  run: Run;
  outcome: RunOutcome | null;
  tickets: readonly { key: string; title: string }[];
  pickBlocker: boolean;
  drafting: boolean;
  on: ResultActions;
}

function BlockerPicker({ tickets, named, own, drafting, on }: { tickets: ResultProps["tickets"]; named: readonly string[]; own: string | null; drafting: boolean; on: ResultActions }) {
  const [query, setQuery] = useState("");
  const choices = blockerChoices(tickets, named, own, query);
  return (
    <div data-esc-local className="grid gap-1.5 rounded-md border border-ws-sep bg-ws-bar p-2.5" onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), on.cancelBlocker())}>
      <label className="grid gap-1 text-sm text-ws-ink2">
        Which ticket blocks {own ?? "this one"}?
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="A ticket key or part of its title"
          className="rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink"
        />
      </label>
      {choices.length > 0 ? (
        <ul className="m-0 grid list-none gap-0.5 p-0" aria-label="Tickets">
          {choices.map((c) => (
            <li key={c.key}>
              <button type="button" disabled={drafting} onClick={() => on.draftBlocker(c.key)} className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-ws-hover disabled:opacity-45">
                <span className="font-mono text-sm font-semibold">{c.key}</span>
                <span className="min-w-0 flex-1 truncate text-ws-ink2">{c.title ?? "Not in your watched projects. Gossamr looks it up."}</span>
                {c.found && <span className="shrink-0 text-xs text-ws-ink3">in the result</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-ws-ink3">{query.trim() ? "No ticket matches. Type a full key such as CA-123." : "The result names no ticket you have. Type a key or part of a title."}</p>
      )}
      <div>
        <Btn tone="ghost" onClick={on.cancelBlocker}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/** What the agent found. Drafting from it is one click and posts nothing. */
export function Found({ run, outcome, tickets, pickBlocker, drafting, on }: ResultProps) {
  const text = run.result?.trim();
  const note = outcome?.note;
  const comment = commentControl(run);
  const blocker = blockerControl(run);
  const reason = comment.reason ?? blocker.reason;
  return (
    <Sec title="What it found">
      <Box>
        {note?.text ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs font-semibold text-ws-ink3">
              {note.fromMarker ? "For Jira, as the agent wrote it" : "No 'For Jira:' section, so this is its whole answer, shortened"}
              {!note.fromMarker && <span className="rounded-full bg-ws-warn/15 px-2 font-semibold text-ws-warn">Not parsed</span>}
            </p>
            <p data-note={note.fromMarker ? "section" : "whole"} className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">
              {note.text}
            </p>
          </>
        ) : text ? (
          <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">{text}</p>
        ) : (
          <p className="m-0 text-ws-ink3">It finished without a written answer.</p>
        )}
        {text && note?.fromMarker && (
          <Details summary="The full answer">
            <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] text-ws-ink2 [overflow-wrap:anywhere]">{text}</p>
          </Details>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Btn tone="primary" icon="ext" disabled={!comment.enabled || drafting} title={comment.reason ?? undefined} onClick={on.draftComment}>
            Draft a Jira comment from this
          </Btn>
          <Btn icon="spark" disabled={!comment.enabled || drafting} title={comment.reason ?? "Pip reads the run and writes a comment for you to edit"} onClick={on.draftWithPip}>
            Draft with Pip
          </Btn>
          <Btn icon="branch" disabled={!blocker.enabled || drafting} aria-expanded={pickBlocker} title={blocker.reason ?? undefined} onClick={pickBlocker ? on.cancelBlocker : on.pickBlocker}>
            Draft a blocker
          </Btn>
          {text && <CopyButton text={text} label="Copy" what="the result" />}
        </div>
        {reason && (
          <p role="note" className="m-0 text-sm text-ws-ink3">
            {reason}
          </p>
        )}
        {pickBlocker && blocker.enabled && <BlockerPicker tickets={tickets} named={outcome?.keys ?? []} own={run.item?.key ?? null} drafting={drafting} on={on} />}
        <p className="m-0 text-xs text-ws-ink3">
          These make drafts for you to read and edit. The words are the agent&apos;s, written after reading ticket text and code. Nothing is posted until you approve a draft.
        </p>
      </Box>
    </Sec>
  );
}

const KIND_NAME: Record<CodeChange["kind"], string> = { pullRequest: "Pull request", branch: "Branch", commit: "Commit" };

/** The pull request or branch the run produced, once a sync has seen it. */
export function Changes({ change, on }: { change: CodeChange; on: Pick<ResultActions, "openChange"> }) {
  const facts = changeSummary(change);
  return (
    <Sec title="Changes">
      <Box>
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 font-semibold">
          <span className="text-xs font-semibold text-ws-ink3 uppercase">{KIND_NAME[change.kind]}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{change.kind === "pullRequest" ? `#${change.number} ${change.title}` : change.headRef}</span>
        </p>
        <p className="m-0 flex flex-wrap gap-x-3 text-sm text-ws-ink2">
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </p>
        <p className="m-0 font-mono text-xs text-ws-ink3 [overflow-wrap:anywhere]">
          {change.repo} · {change.headRef}
        </p>
        <div>
          <Btn icon="ext" onClick={() => on.openChange(change.url)}>
            {change.kind === "pullRequest" ? "Open PR on GitHub" : "Open branch on GitHub"}
          </Btn>
        </div>
      </Box>
    </Sec>
  );
}
