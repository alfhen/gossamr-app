import { useClaude } from "../claudeStore";
import { useWorkspace } from "../workspaceStore";
import { LAST_STEP, STEPS, hasManagerApi, playStep, type Place, type ScenarioBackend, type ScenarioEnv } from "./managerScenario";
import { managerSettings, useManager } from "./managerProto";
import { openTicketByKey } from "./jump";
import { WORKSPACE_CONVERSATION } from "./PipPane";
import { currentContext } from "./pipHooks";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const answering = () => useClaude.getState().byTicket[WORKSPACE_CONVERSATION]?.turns.some((t) => t.status === "running") ?? false;

async function ask(prompt: string, notice?: { heading: string; body: string }) {
  while (answering()) await sleep(150);
  usePrefs.getState().setPipOpen(true);
  const sessionId = useClaude.getState().byTicket[WORKSPACE_CONVERSATION]?.sessionId ?? null;
  await useClaude.getState().ask(WORKSPACE_CONVERSATION, prompt, sessionId, currentContext(), { looking: notice ? "the finished run" : "your question", notice });
}

function show(where: Place) {
  const tabs = useTabs.getState();
  if (where === "board") {
    tabs.setRoute("workspace");
    tabs.setView("board");
  } else if (where === "settings") tabs.openSettings("manager");
  else if (typeof where === "object") {
    tabs.setView("board");
    void openTicketByKey(where.ticket);
  } else tabs.setRoute(where);
}

export function liveEnv(backend: ScenarioBackend): ScenarioEnv {
  return {
    backend,
    settings: managerSettings,
    turnOnReview: () => useManager.getState().change({ reviewFinished: true }),
    notify: ask,
    chat: (text) => ask(text),
    say: (text) => useToasts.getState().push(text, "info"),
    show,
    pause: sleep,
  };
}

/** Plays the next step of the story. A step still playing out is left to finish first. */
export async function nextStep(): Promise<void> {
  const state = useManager.getState();
  if (state.busy) return;
  const backend = useWorkspace.getState().backend;
  if (!hasManagerApi(backend)) {
    useToasts.getState().push("The prototype scenario needs the sample data.", "error");
    return;
  }
  const step = state.step + 1;
  if (step > LAST_STEP) {
    useToasts.getState().push("That is the end of the story. Press Reset to play it again.", "info");
    return;
  }
  state.setStep(step, true);
  try {
    await playStep(liveEnv(backend), step);
  } catch (e) {
    useToasts.getState().push(`Step ${step} (${STEPS[step].title}) stopped: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    useManager.getState().setStep(step, false);
  }
}

/** Back to the start: the sample data is read again and Pip's switches return to their defaults. */
export function resetScenario() {
  useManager.getState().resetSettings();
  location.reload();
}
