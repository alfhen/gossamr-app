import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, editTicket, expandNeedsYou, homeConversationRegion, homeSettled, jiraWrites, mockRuns, needRow, needsPane, openAgents, openApp, paneSettled, pipPane, selectWorkstream, startWorkstream, openNeedRow } from "./support/app";

// Round 18 dogfood, CA-408 with the description "Fix it.": the triage's open questions go to the ticket's description as a
// draft the person approves.

const SAMPLE = "runs=empty&prSurface=manual&pipPace=1";
const KEY = "CA-408";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const runsOf = async (page: Page, kind: string) => (await mockRuns(page)).filter((r) => r.kind === kind);

/** Asks Pip for `what` and starts it from the setup sheet, as the person does, in the Pip pane or on Pip home. */
async function startStep(page: Page, what: string, home = false) {
  if (home) await homeSettled(page);
  else await paneSettled(page);
  await askPip(page, what);
  if (home) await homeSettled(page);
  else await paneSettled(page);
  const where = home ? homeConversationRegion(page) : pipPane(page);
  await where.getByRole("article", { name: `Start an agent: ${KEY}` }).last().getByRole("button", { name: /^Review and start/ }).click();
  await expect(setup(page)).toBeVisible();
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

async function finish(page: Page, id: string) {
  await paneSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** The id of the `n`th run of `kind`. */
async function nth(page: Page, kind: string, n: number) {
  await expect.poll(async () => (await runsOf(page, kind)).length).toBeGreaterThanOrEqual(n);
  return (await runsOf(page, kind)).map((r) => r.id).reverse()[n - 1];
}

test("the triage's questions go to the description as a draft, and nothing is posted", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page, SAMPLE);
  await editTicket(page, KEY, { description: "Fix it." });
  await startWorkstream(page, KEY);
  await startStep(page, "investigate this");
  await finish(page, await nth(page, "investigate", 1));
  await startStep(page, "triage this");
  await finish(page, await nth(page, "triage", 1));
  await openAgents(page);
  await selectWorkstream(page, KEY);

  // The triage's note and open questions are a description update, not a comment on the ticket.
  await expandNeedsYou(page, KEY);
  await expect(needRow(page, /triage · comment/)).toHaveCount(0);
  await openNeedRow(page, "R2 triage · rewrite");
  const update = needsPane(page).getByRole("article", { name: `Update the description of ${KEY}` });
  await expect(update).toBeVisible();
  const diff = update.locator('[data-diff="description"]');
  await expect(diff).toContainText("Triage");
  await expect(diff).toContainText("The ticket cannot be sized yet");
  await expect(diff).toContainText("Open questions:");
  await expect(diff).toContainText("What does done look like for CA-408?");
  await expect(update).toContainText("From the CA-408 triage");
  expect(await jiraWrites(page)).toEqual([]);

  // Every draft the app made waits for the person.
  expect(await jiraWrites(page)).toEqual([]);
});
