import type { Backend } from "../backend/types";
import { FINISH, QUESTION_OPTIONS, QUIET_VERDICT, managerReply, noticeText, type Finish, type ManagerApi } from "../backend/mockManager";
import { jiraNote } from "../backend/mockRunResult";
import { MANAGER_ON_NOTICE } from "../backend/mockPip";
import type { Run } from "../types";
import { KIND_LABEL, formatTokens } from "./agentsLogic";
import type { ManagerSettings } from "./managerProto";

export type ScenarioBackend = Backend & ManagerApi;

export const hasManagerApi = (backend: unknown): backend is ScenarioBackend => !!backend && typeof (backend as Partial<ManagerApi>).managerFinish === "function";

export type Place = "board" | "agents" | "manager" | "settings" | { ticket: string };

/** Everything the scenario needs from the app, so the story can be played against the sample backend with no screen. */
export interface ScenarioEnv {
  backend: ScenarioBackend;
  settings(): ManagerSettings;
  /** Turns on the review switch, as the person would in Settings. */
  turnOnReview(): void;
  /** The app tells Pip something, and resolves once Pip has answered. */
  notify(prompt: string, notice: { heading: string; body: string }): Promise<void>;
  /** The person says something to Pip, and resolves once Pip has answered. */
  chat(text: string): Promise<void>;
  say(text: string): void;
  show(where: Place): void;
  pause(ms: number): Promise<void>;
}

export interface Step {
  title: string;
  caption: string;
}

export const ROUNDING_REQUEST = "look into why checkout rounding is wrong";

export const STEPS: Step[] = [
  { title: "Start", caption: "Five agent runs are working and Pip's review is off, which is the default. Pip does nothing on its own yet." },
  { title: "Turn on manager mode", caption: "One switch wakes Pip up: Pip reviews finished runs. Auto send-back and runs from chat are separate. Build, push and Jira writes always ask." },
  { title: "A run finishes and Pip proposes", caption: "CA-271 finishes. Gossamr, not you, tells Pip. Pip answers in the pane with two drafts. Approve there, on the ticket or in Waiting for you." },
  { title: "Pip corrects a mismatch", caption: "CA-401's note and its answer disagree. Pip fixes the comment before you see it and shows what it changed." },
  { title: "Nothing to do", caption: "CA-355 needs nothing. No message in the pane and nothing in the inbox; the run is marked Checked by Pip." },
  { title: "Needs your answer", caption: "CA-388 stopped on a question. Pip does not guess; the run waits in Waiting for you." },
  { title: "Send-back proposed", caption: "CA-412 only checked half. Pip drafts Follow-up for run CA-412 with the exact message and a pass counter. Approve it, or turn on automatic send-back in Settings and Reset." },
  { title: "Follow-up sent, run done again", caption: "The run goes back to Working and finishes again. Its timeline shows Pip asked for another pass. Open the run to see it." },
  { title: "Pip-first chat", caption: "You tell Pip what you want. With no ticket, Pip proposes a read-only investigation whose prompt you can edit before anything starts." },
  { title: "Pip reports back", caption: "The run you started finishes. Pip reports in the pane and drafts a ticket. Everything it needs from you is in Waiting for you." },
  { title: "On the ticket", caption: "Open CA-271: its drafts and agent runs sit together, with the badges the board shows. That is the end of the story." },
];

export const LAST_STEP = STEPS.length - 1;

function need<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`The scenario expected ${what}`);
  return value;
}

const runFor = (env: ScenarioEnv, key: string): Run => need(env.backend.managerRun(key), `a run for ${key}`);

async function review(env: ScenarioEnv, runId: string) {
  const settings = env.settings();
  if (!settings.reviewFinished) return;
  const run = need(await env.backend.runsGet(runId), "the run");
  const passes = run.passes ?? 0;
  const facts = { runId, key: run.item?.key ?? null, passes, max: settings.maxPasses, auto: settings.autoSendBack };
  if (managerReply(facts) === null) {
    await env.backend.managerVerdict(runId, QUIET_VERDICT);
    env.say(`${run.item?.key ?? "The run"} checked by Pip: nothing to do. No message, nothing in the inbox.`);
    return;
  }
  const note = jiraNote(run.result ?? "").text;
  const tokens = formatTokens(run.tokens);
  await env.notify(noticeText(run, passes, settings, note), {
    heading: `${run.item?.key ?? "A run with no ticket"} finished${passes ? ` again (pass ${passes})` : ""}`,
    body: [`${KIND_LABEL[run.spec.kind]} in ${run.spec.repo}`, run.summary, tokens].filter(Boolean).join(" · "),
  });
}

async function finish(env: ScenarioEnv, run: Run, f: Finish) {
  await env.backend.managerFinish(run.id, f);
  await review(env, run.id);
}

const pendingFollowUp = async (env: ScenarioEnv, runId: string) =>
  (await env.backend.proposalsList({ states: ["pending"] })).find((p) => p.intent.type === "followUp" && p.intent.run === runId);

async function sendBackAndFinish(env: ScenarioEnv) {
  const run = runFor(env, "CA-412");
  const waiting = await pendingFollowUp(env, run.id);
  if (waiting) await env.backend.proposalsApprove(waiting.id);
  const now = need(await env.backend.runsGet(run.id), "the run");
  if (now.state !== "working") {
    env.say("Nothing was sent back. Turn on Pip reviews finished runs in Settings, Reset, and play from step 2.");
    return;
  }
  await env.pause(700);
  await env.backend.managerSecondPass(run.id);
  await env.pause(1100);
  await finish(env, now, FINISH["CA-412/2"]);
}

async function startAndFinishRounding(env: ScenarioEnv) {
  const drafts = await env.backend.proposalsList({ states: ["pending"] });
  const proposed = drafts.find((p) => p.intent.type === "startRun" && !p.intent.item && p.createdBy === "pip");
  let run = (await env.backend.runsList()).find((r) => !r.item && !!r.spec.project && r.state !== "done" && r.state !== "stopped");
  if (!run && proposed) {
    env.say("Started the investigation for you. In the real flow you press Start after reading the prompt.");
    const reviewed = await env.backend.runsReview(proposed.id);
    run = await env.backend.runsApprove(proposed.id, reviewed.digest);
  }
  if (!run) {
    env.say("There is no investigation to finish. Play step 8 first, or start the one Pip proposed.");
    return;
  }
  env.show("agents");
  for (let i = 0; i < 3 && run; i++) {
    run = (await env.backend.managerAdvance(run.id)) ?? run;
    if (run.state === "working") break;
    await env.pause(500);
  }
  await env.pause(1100);
  await finish(env, run, FINISH.rounding);
  env.show("manager");
}

/** Plays one step of the story. Steps are idempotent only in the sense that a step the story has not reached yet does nothing useful, so the bar walks them in order. */
export async function playStep(env: ScenarioEnv, step: number): Promise<void> {
  switch (step) {
    case 0:
      env.show("board");
      return;
    case 1:
      env.turnOnReview();
      env.show("settings");
      return env.notify(MANAGER_ON_NOTICE, { heading: "Manager mode turned on", body: "Pip reviews finished runs. Build, push and Jira writes still ask you." });
    case 2:
      env.show("manager");
      await env.pause(500);
      return finish(env, runFor(env, "CA-271"), FINISH["CA-271"]);
    case 3:
      env.show("manager");
      await env.pause(400);
      return finish(env, runFor(env, "CA-401"), FINISH["CA-401"]);
    case 4:
      env.show("agents");
      await env.pause(400);
      return finish(env, runFor(env, "CA-355"), FINISH["CA-355"]);
    case 5: {
      env.show("manager");
      await env.pause(400);
      const run = runFor(env, "CA-388");
      await env.backend.managerAsk(run.id, FINISH["CA-388"].note, QUESTION_OPTIONS, FINISH["CA-388"]);
      return review(env, run.id);
    }
    case 6:
      env.show("manager");
      await env.pause(400);
      return finish(env, runFor(env, "CA-412"), FINISH["CA-412"]);
    case 7:
      env.show("manager");
      return sendBackAndFinish(env);
    case 8:
      env.show("board");
      return env.chat(ROUNDING_REQUEST);
    case 9:
      return startAndFinishRounding(env);
    case 10:
      env.show({ ticket: "CA-271" });
      return;
  }
}
