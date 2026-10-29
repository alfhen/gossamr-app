import { expect, type Page } from "@playwright/test";
import { advanceRuns, askPip, mockRuns, paneSettled } from "./app";

/** The newest run of `kind` (investigate, triage, plan, build, review, verify), as the sample backend holds it. */
export const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.step === kind) ?? null;

/** Asks Pip in the pane for `what` on the ticket it is about, which starts the agent, and waits until Pip has answered. */
export async function startStep(page: Page, what: string) {
  await askPip(page, what);
  await paneSettled(page);
}

/**
 * Moves run `id` on to done (queued, launching, working, done) once Pip has answered, so each finish gets a wake turn of its own
 * rather than merging into one still waiting. `settle` is how that wait is told: the pane's by default, `homeSettled` on Work.
 */
export async function finishRun(page: Page, id: string, settle: (page: Page) => Promise<void> = paneSettled) {
  await settle(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}
