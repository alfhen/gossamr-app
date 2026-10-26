import { useEffect, useState } from "react";
import type { Run } from "../types";
import { Box, BoxTitle, Btn, Details } from "./AgentSheet";
import { answerKey, dropKeptAnswer, forgetKeptAnswers, keptAnswer, setKeptAnswer } from "./keptAnswers";
import { ANSWER_REMINDER, answerDraft, canSendAnswer, resumable, suggestedAnswer } from "./runSheetLogic";

export interface AnswerActions {
  /** Sends the answer; resolves `true` once it got through, so the kept text is dropped only then. */
  answer(text: string): Promise<boolean> | void;
  attach(): void;
}

export { forgetKeptAnswers, keepAnswer } from "./keptAnswers";

/** The agent's question with a box to answer it in; for a run stopped with an answer that didn't get through, that answer to send again; for a run Gossamr stopped at a limit, the words to resume it with. */
export function RunAnswer({ run, answering, on }: { run: Run; answering: boolean; on: AnswerActions }) {
  const key = answerKey(run);
  const [text, setTextState] = useState(() => keptAnswer(key) ?? answerDraft(run));
  // A new question on the same card starts from its own kept text or draft, not the last question's answer.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setTextState(keptAnswer(key) ?? answerDraft(run));
  }
  const setText = (v: string) => (setKeptAnswer(key, v), setTextState(v));
  const waiting = run.state === "needsAnswer" || run.state === "stopped";
  useEffect(() => {
    if (!waiting) forgetKeptAnswers(run.id);
  }, [waiting, run.id]);
  const suggestion = suggestedAnswer(run);
  const limit = resumable(run);
  const again = run.state === "stopped" && !limit;
  const ready = canSendAnswer(text) && !answering;
  const send = () => {
    if (!ready) return;
    void Promise.resolve(on.answer(text)).then((ok) => {
      if (ok) dropKeptAnswer(key);
    });
  };
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
        placeholder={limit ? "What to tell it" : suggestion ? "Write your answer, or use Claude's suggestion below" : "Write your answer"}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) (ev.preventDefault(), send());
        }}
        className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2.5 py-1.5 leading-normal text-ws-ink outline-offset-2 disabled:opacity-60"
      />
      {suggestion && (
        <div data-suggested-answer className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ws-ink2">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <b className="font-semibold text-ws-ink">Claude suggests:</b> “{suggestion}”
          </span>
          <Btn tone="ghost" disabled={answering} onClick={() => setText(suggestion)} aria-label="Use this suggestion">
            Use this
          </Btn>
        </div>
      )}
      <Details summary="What Gossamr adds">
        <p className="m-0 text-xs text-ws-ink3">This goes in front of your answer: {ANSWER_REMINDER}</p>
      </Details>
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
          : run.asking
            ? "Your answer goes straight to the agent, which is waiting for it. Only the agent sees it; nothing goes to Jira."
            : "Gossamr stops the agent and wakes it with your answer, which takes a few seconds. Its conversation is kept. Only the agent sees your answer; nothing goes to Jira."}
      </p>
    </Box>
  );
}
