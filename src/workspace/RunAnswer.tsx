import { useState } from "react";
import type { Run } from "../types";
import { Box, BoxTitle, Btn } from "./AgentSheet";
import { ANSWER_REMINDER, answerDraft, canSendAnswer, resumable } from "./runSheetLogic";

export interface AnswerActions {
  answer(text: string): void;
  attach(): void;
}

/** The agent's question with a box to answer it in; for a run stopped with an answer that didn't get through, that answer to send again; for a run Gossamr stopped at a limit, the words to resume it with. */
export function RunAnswer({ run, answering, on }: { run: Run; answering: boolean; on: AnswerActions }) {
  const [text, setText] = useState(() => answerDraft(run));
  const limit = resumable(run);
  const again = run.state === "stopped" && !limit;
  const ready = canSendAnswer(text) && !answering;
  const send = () => ready && on.answer(text);
  return (
    <Box tone="needs" label={limit ? "Stopped at its limit" : "Question from the agent"}>
      <BoxTitle icon={limit ? "clock" : "hand"} tone="needs">
        {limit ? "Gossamr stopped this agent at its limit" : again ? "Your answer didn't get through" : "Claude is asking you"}
      </BoxTitle>
      {limit ? (
        <p className="selectable m-0 text-ws-ink2 [overflow-wrap:anywhere]">
          {(run.error?.trim() || "It passed its limit").replace(/\.*$/, ".")} Its conversation and worktree are kept, and it may have been waiting for you.
          {run.lastDetail?.trim() ? ` It was at: ${run.lastDetail.trim()}` : ""}
        </p>
      ) : again ? (
        <p className="selectable m-0 text-ws-ink2 [overflow-wrap:anywhere]">{run.error?.trim() || "The agent was stopped before it could be woken."}</p>
      ) : (
        <q className="selectable block border-l-[3px] border-ws-sep2 py-0.5 pl-3 whitespace-pre-wrap text-ws-ink [quotes:none]">{run.needs?.trim() || "It is waiting for you"}</q>
      )}
      <textarea
        aria-label={limit ? "What to tell it" : "Your answer"}
        rows={3}
        value={text}
        disabled={answering}
        placeholder={limit ? "What to tell it" : "Your answer"}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) (ev.preventDefault(), send());
        }}
        className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2.5 py-1.5 leading-normal text-ws-ink outline-offset-2 disabled:opacity-60"
      />
      <p className="m-0 text-xs text-ws-ink3">Added in front of your answer: {ANSWER_REMINDER}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="primary" icon="play" disabled={!ready} title={canSendAnswer(text) ? undefined : "Write an answer first"} onClick={send}>
          {answering ? "Sending…" : limit ? "Resume" : again ? "Start it again with your answer" : "Send answer"}
        </Btn>
        {!again && (
          <Btn icon="term" disabled={answering} onClick={on.attach}>
            Open in Terminal
          </Btn>
        )}
      </div>
      <p className="m-0 text-xs text-ws-ink3">
        {limit
          ? "Gossamr wakes the agent with the words above, which takes a few seconds. After a resume the limits no longer stop this run."
          : "Gossamr stops the agent and wakes it with your answer, which takes a few seconds. Its conversation is kept."}
      </p>
    </Box>
  );
}
