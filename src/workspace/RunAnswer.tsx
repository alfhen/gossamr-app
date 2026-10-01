import { useState } from "react";
import type { Run } from "../types";
import { Box, BoxTitle, Btn } from "./AgentSheet";
import { ANSWER_REMINDER, answerDraft, canSendAnswer } from "./runSheetLogic";

export interface AnswerActions {
  answer(text: string): void;
  attach(): void;
}

/** The agent's question with a box to answer it in, or, for a run stopped with an answer that didn't get through, that answer to send again. */
export function RunAnswer({ run, answering, on }: { run: Run; answering: boolean; on: AnswerActions }) {
  const [text, setText] = useState(() => answerDraft(run));
  const again = run.state === "stopped";
  const ready = canSendAnswer(text) && !answering;
  const send = () => ready && on.answer(text);
  return (
    <Box tone="needs" label="Question from the agent">
      <BoxTitle icon="hand" tone="needs">
        {again ? "Your answer didn't get through" : "Claude is asking you"}
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
        placeholder="Your answer"
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) (ev.preventDefault(), send());
        }}
        className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2.5 py-1.5 leading-normal text-ws-ink outline-offset-2 disabled:opacity-60"
      />
      <p className="m-0 text-xs text-ws-ink3">Added in front of your answer: {ANSWER_REMINDER}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="primary" icon="play" disabled={!ready} title={canSendAnswer(text) ? undefined : "Write an answer first"} onClick={send}>
          {answering ? "Sending…" : again ? "Start it again with your answer" : "Send answer"}
        </Btn>
        {!again && (
          <Btn icon="term" disabled={answering} onClick={on.attach}>
            Open in Terminal
          </Btn>
        )}
      </div>
      <p className="m-0 text-xs text-ws-ink3">Gossamr stops the agent and wakes it with your answer, which takes a few seconds. Its conversation is kept.</p>
    </Box>
  );
}
