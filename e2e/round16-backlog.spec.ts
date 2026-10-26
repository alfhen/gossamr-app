import { expect, test, type Page } from "@playwright/test";
import { agentsHome, editTicket, jiraWrites, needsPane, openAgents, openApp, pipPane, seedWorkstreamEvent, selectWorkstream, startWorkstream, stepChip, workstreamEvents } from "./support/app";

// Backlog items of the sixteenth dogfood round: the ask and the nudge to the reporter (G20, G21), what Close does to agents (G24),
// the posting pause naming its line (G33), Pause and the other controls drawn as buttons (G30)
// and every step stating its state (G34).

const THIN = "Fix it.";
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const notice = (page: Page) => agentsHome(page).locator("[data-clarity-notice]");

/** The reporter question draft on a vague ticket: a workstream on it, "Ask the reporter now" pressed, its card in the decision pane. */
async function reporterDraft(page: Page, query = "runs=empty") {
  await openApp(page, query);
  await editTicket(page, "CA-408", { description: THIN });
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await startWorkstream(page, "CA-408");
  await openAgents(page);
  await selectWorkstream(page, "CA-408");
  await notice(page).getByRole("button", { name: "Ask the reporter now" }).click();
  const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("the ask and the nudge to the reporter (G21, G20)", () => {
  test("the ask leaves out the ticket key and says why it asks; the nudge lists the questions still open", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await expect(draft).toContainText("A few things need clearing up to make this ticket clear to work on:");
    await expect(draft).not.toContainText("A few things about CA-408");
    const asked = (await draft.innerText()).split("\n").filter((l) => /^- /.test(l.trim()) || /^[A-Z].*\?$/.test(l.trim()));
    expect(asked.length).toBeGreaterThan(0);
    // The ask is posted, and waited long enough: its approval is dated days back, so the nudge is due.
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).map((w) => [w.type, w.key])).toEqual([["comment", "CA-408"]]);
    const ask = (await workstreamEvents(page)).find((e) => e.action === "clarity_asked")!;
    await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "draft_approved", at: ago(3), proposalId: (ask as { proposalId?: string | null }).proposalId });
    await page.keyboard.press("Escape");
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-next-step]").getByRole("button", { name: "Draft a nudge" }).click();
    const nudge = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(nudge).toContainText("The earlier questions about CA-408 are still open:");
    await expect(nudge).toContainText("What is the goal?");
    await expect(nudge).not.toContainText(/\b(runs?|workstreams?|Pip|Gossamr)\b.*still open/);
    // Only the ask went to Jira; the nudge waits for its own Post comment.
    expect((await jiraWrites(page)).map((w) => w.proposalId)).toEqual([(ask as { proposalId?: string | null }).proposalId]);
  });
});

test.describe("Close, Pause and the posting pause (G24, G30, G33)", () => {
  test("the Close confirm says what happens to agents, and Pause, Close… and ⋯ have a border", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    for (const name of ["Pause", "Close…", "More for this workstream"]) await expect(controls.getByRole("button", { name, exact: true })).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await controls.getByRole("button", { name: "Close…", exact: true }).click();
    const confirm = controls.getByRole("group", { name: "Close this workstream" });
    await expect(confirm).toContainText("Agents already running carry on; one still queued does not start while it is closed.");
    // Keep has the keyboard and is described by the question, so it is read with it.
    const keep = confirm.getByRole("button", { name: "Keep" });
    await expect(keep).toBeFocused();
    await expect(keep).toHaveAccessibleDescription(/Close it\? Its conversation goes back to General/);
  });

  test("the pause names the line of a secret in a long draft", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    const before = await text.inputValue();
    await text.fill(`${before}\n\nPassword: hunter22secret`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    const lines = `${before}\n\nPassword: hunter22secret`.split("\n").length;
    await expect(draft.locator("[data-post-pause]")).toContainText(`“hu…” (line ${lines})`);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("steps that say their state (G34)", () => {
  test("every step of the rail has a state in its name", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    for (const kind of ["investigate", "triage", "plan", "build", "review", "verify"]) await expect(stepChip(page, kind).locator("[data-step-chip]")).toHaveAccessibleName(/Not started/);
  });
});

