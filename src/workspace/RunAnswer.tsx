import { useEffect, useState } from "react";
import { HANDED_OVER_ASK, type Run } from "../types";
import { Box, BoxTitle, Btn, Details } from "./AgentSheet";
import { Icon } from "./AgentIcons";
import { answerKey, dropKeptAnswer, forgetKeptAnswers, keptAnswer, setKeptAnswer } from "./keptAnswers";
import { ANSWER_REMINDER, answerDraft, canSendAnswer, suggestedAnswer } from "./runSheetLogic";
import { useRuns } from "./runsStore";

export interface AnswerActions {
  /** Sends the answer; resolves `true` once it got through, so the kept text is dropped only then. `tookBack`: you said you took a run handed over to Terminal back. */
  answer(text: string, options?: { tookBack?: boolean }): Promise<boolean> | void;
  attach(): void;
}

export { forgetKeptAnswers, keepAnswer } from "./keptAnswers";

/**
 * The agent's question with a box to answer it in; for a run stopped with an answer that didn't get through, that answer to
 * send again. A run handed over to Terminal takes the answer only once you say you took it back there.
 */
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
  const again = run.state === "stopped";
  const handedOver = useRuns((s) => s.handedOverAsked.has(run.id)) || !!run.handedOver;
  const ready = canSendAnswer(text) && !answering;
  const send = (tookBack = false) => {
    if (!ready || (handedOver && !tookBack)) return;
    void Promise.resolve(on.answer(text, tookBack ? { tookBack } : undefined)).then((ok) => {
      if (ok) dropKeptAnswer(key);
    });
  };
  return (
    <Box tone="needs" label="Question from the agent">
      <BoxTitle icon="hand" tone="needs">
        {again ? "Your answer didn't get through" : "The agent is asking you"}
      </BoxTitle>
      {again ? (
        <p className="selectable m-0 text-ws-ink2 [overflow-wrap:anywhere]">{run.error?.trim() || "The agent was stopped before it could be woken."}</p>
      ) : (
        <q className="selectable block border-l-[3px] border-ws-sep2 py-0.5 pl-3 whitespace-pre-wrap text-ws-ink [quotes:none]">{run.needs?.trim() || "It is waiting for you"}</q>
      )}
      <textarea
        aria-label="Your answer"
        rows={3}
        value={text}
        disabled={answering}
        placeholder={suggestion ? "Write your answer, or use Claude's suggestion below" : "Write your answer"}
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
      {handedOver && (
        <p role="status" data-handed-over className="m-0 flex items-start gap-1.5 text-ws-ink">
          <Icon name="term" className="mt-0.5 size-3.5 shrink-0" />
          {HANDED_OVER_ASK}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="primary" icon="play" disabled={!ready} title={canSendAnswer(text) ? undefined : "Write an answer first"} onClick={() => send(handedOver)}>
          {answering ? "Sending…" : handedOver ? "I took it back" : again ? "Start it again with your answer" : "Send answer"}
        </Btn>
        {!again && (
          <Btn icon="term" disabled={answering} onClick={on.attach}>
            Open in Terminal
          </Btn>
        )}
      </div>
      <p className="m-0 text-xs text-ws-ink3">
        {handedOver
          ? "If the session is still open in Terminal, answer it there instead. Only the agent sees your answer; nothing goes to Jira."
          : run.harnessSession
            ? "Your answer reaches the agent when its current turn ends. Its conversation is kept. Only the agent sees your answer; nothing goes to Jira."
            : run.asking
              ? "Your answer goes straight to the agent, which is waiting for it. Only the agent sees it; nothing goes to Jira."
              : "Gossamr stops the agent and wakes it with your answer, which takes a few seconds. Its conversation is kept. Only the agent sees your answer; nothing goes to Jira."}
      </p>
    </Box>
  );
}
