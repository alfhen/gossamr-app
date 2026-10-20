import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, askPip, commentOnTicket, editTicket, expandNeedsYou, homeConversationRegion, homeSettled, jiraWrites, mockRuns, needOfKind, needRow, needsPane, openAgents, openApp, paneSettled, pipPane, selectWorkstream, startWorkstream, openNeedOfKind, openNeedRow } from "./support/app";

// Round 18 dogfood, CA-408 with the description "Fix it.": the triage's open questions go to the ticket's description as a
// draft the person approves; "Ask the reporter" stays a comment; the reporter's answer is read by the next triage and the
// plan, which neither ask the questions again nor assume answers to them.

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const KEY = "CA-408";
const ANSWER = "Done means the winback mail goes to lapsed customers. The open rate should rise. Only the winback flow is in scope. The CRM team asked for it.";

const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const runsOf = async (page: Page, kind: string) => (await mockRuns(page)).filter((r) => r.kind === kind);

/** Asks Pip for an investigation and starts it from the setup sheet, as the person does, in the Pip pane or on Pip home. */
async function startInvestigation(page: Page, home = false) {
  if (home) await homeSettled(page);
  else await paneSettled(page);
  await askPip(page, "investigate this");
  if (home) await homeSettled(page);
  else await paneSettled(page);
  const where = home ? homeConversationRegion(page) : pipPane(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await where.getByRole("article", { name: `Start an agent: ${KEY}` }).last().getByRole("button", { name: /^Review and start/ }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
}

async function finish(page: Page, id: string) {
  await paneSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** The id of the `n`th run of `kind`, once the rules have started it. */
async function nth(page: Page, kind: string, n: number) {
  await expect.poll(async () => (await runsOf(page, kind)).length).toBeGreaterThanOrEqual(n);
  return (await runsOf(page, kind)).map((r) => r.id).reverse()[n - 1];
}

test("the triage's questions go to the description as a draft, the reporter's answer is used, and the plan assumes nothing", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page, MANAGED);
  await editTicket(page, KEY, { description: "Fix it." });
  await startWorkstream(page, KEY);
  await startInvestigation(page);
  await finish(page, await nth(page, "investigate", 1));
  await finish(page, await nth(page, "triage", 1));
  await openAgents(page);
  await selectWorkstream(page, KEY);
  await expect(needOfKind(page, "readiness")).toBeVisible();

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

  // "Ask the reporter" is still a comment, so Jira notifies the reporter.
  await openNeedOfKind(page, "readiness");
  await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
  await needsPane(page).getByRole("article", { name: `Comment on ${KEY}` }).getByRole("button", { name: "Post comment" }).click();
  await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", KEY]]);
  const ask = (await jiraWrites(page))[0].text ?? "";
  expect(ask).toContain("Hi");
  expect(ask).toContain("What does done look like for CA-408?");

  // The reporter answers all four questions in a comment.
  await new Promise((r) => setTimeout(r, 50));
  await commentOnTicket(page, KEY, ANSWER);

  // Investigate again: the triage the rule starts reads the answers, so it is ready and asks nothing again.
  await openAgents(page);
  await selectWorkstream(page, KEY);
  await startInvestigation(page, true);
  await finish(page, await nth(page, "investigate", 2));
  const again = await nth(page, "triage", 2);
  await finish(page, again);
  await expect(needOfKind(page, "readiness")).toHaveCount(0);
  // Its description update replaces the Triage section: the note says the answers were used and lists no question.
  await expandNeedsYou(page, KEY);
  await needRow(page, "R4 triage · rewrite").first().click();
  const second = needsPane(page).getByRole("article", { name: `Update the description of ${KEY}` });
  await expect(second.locator('[data-diff="description"]')).toContainText("The answers in the ticket's comments were used");
  await expect(second.locator('[data-diff="description"]')).not.toContainText("Open questions:");

  // The plan the rule starts is told no assumptions, and its description draft invents none.
  const plan = await nth(page, "plan", 1);
  await finish(page, plan);
  await openNeedOfKind(page, "plan");
  const pane = needsPane(page);
  await expect(pane).toContainText("Gossamr Plan");
  await expect(pane).not.toContainText("assumes answers");
  await expect(pane).not.toContainText("Assumed:");
  await expect(pane).not.toContainText("chose to plan without answers");

  // Nothing but the ask went to Jira: every draft the app made waits for the person.
  expect((await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", KEY]]);
});
