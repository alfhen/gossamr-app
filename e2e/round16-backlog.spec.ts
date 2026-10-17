import { expect, test, type Page } from "@playwright/test";
import { agentsSettled, askPip, editTicket, homeRunCards, homeSettled, jiraWrites, needsPane, openApp, openPipHome, pipHome, seedWorkstreamEvent, startWorkstream, stepChip, workstreamEvents, workstreamRow } from "./support/app";

// Backlog items of the sixteenth dogfood round: the ask and the nudge to the reporter (G20, G21), what Close does to agents (G24),
// the posting pause naming its line (G33), Hold and the other controls drawn as buttons (G30), an Undo that names itself (G29),
// every step stating its state (G34) and the review saying nothing has started after the safety sheet (G28).

const THIN = "Fix it.";
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const toast = (page: Page) => page.locator("[data-toast]");
const notice = (page: Page) => pipHome(page).locator("[data-clarity-notice]");

/** The reporter question draft on a vague ticket: a workstream on it, "Ask the reporter now" pressed, its card in the decision pane. */
async function reporterDraft(page: Page, query = "runs=empty") {
  await openApp(page, query);
  await editTicket(page, "CA-408", { description: THIN });
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await startWorkstream(page, "CA-408");
  await openPipHome(page);
  await workstreamRow(page, "CA-408").click();
  await notice(page).getByRole("button", { name: "Ask the reporter now" }).click();
  const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
  await expect(draft).toBeVisible();
  return draft;
}

test.describe("the ask and the nudge to the reporter (G21, G20)", () => {
  test("the ask leaves out the ticket key and says why it asks; the nudge lists the questions still open", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await reporterDraft(page);
    await expect(draft).toContainText("A few things need clearing up before work on this starts:");
    await expect(draft).not.toContainText("A few things about CA-408");
    const asked = (await draft.innerText()).split("\n").filter((l) => /^- /.test(l.trim()) || /^[A-Z].*\?$/.test(l.trim()));
    expect(asked.length).toBeGreaterThan(0);
    // The ask waited long enough: its approval is dated days back, so the nudge is due.
    const ask = (await workstreamEvents(page)).find((e) => e.action === "clarity_asked")!;
    await seedWorkstreamEvent(page, "CA-408", { actor: "person", action: "draft_approved", at: ago(3), proposalId: (ask as { proposalId?: string | null }).proposalId });
    await page.keyboard.press("Escape");
    await workstreamRow(page, "CA-408").click();
    await pipHome(page).locator("[data-next-step]").getByRole("button", { name: "Draft a nudge" }).click();
    const nudge = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(nudge).toContainText("The earlier questions about CA-408 are still open:");
    await expect(nudge).toContainText("What is the goal?");
    await expect(nudge).not.toContainText(/\b(runs?|workstreams?|Pip|Gossamr)\b.*still open/);
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("Close, Hold and the posting pause (G24, G30, G33)", () => {
  test("the Close confirm says what happens to agents, and Hold, Close… and ⋯ have a border", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "wsManage=1&runs=empty");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    for (const name of ["Hold", "Close…", "More for this workstream"]) await expect(controls.getByRole("button", { name, exact: true })).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
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

test.describe("an Undo that names itself and steps that say their state (G29, G34)", () => {
  test("Hold's toast reads Undo hold, and every step of the rail has a state in its name", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "wsManage=1&runs=empty");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await pipHome(page).getByRole("button", { name: "Hold", exact: true }).click();
    await expect(toast(page).getByRole("button", { name: "Undo hold" })).toBeVisible();
    await expect(toast(page).getByRole("button", { name: "Undo hold" })).toHaveText("Undo hold");
    for (const kind of ["investigate", "triage", "plan", "build", "review", "verify"]) await expect(stepChip(page, kind).locator("[data-step-chip]")).toHaveAccessibleName(/Not started/);
  });
});

test.describe("the review after the one-time safety sheet (G28)", () => {
  test("says nothing has started yet", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty&prSurface=manual&wsManage=1");
    await agentsSettled(page);
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await askPip(page, "Investigate CA-401");
    await homeSettled(page);
    const card = homeRunCards(page, "CA-401").last();
    await card.getByRole("button", { name: "Review and start", exact: true }).click();
    await page.getByRole("dialog", { name: "Agents safety and settings" }).getByRole("button", { name: "Got it, continue" }).click();
    await expect(card.locator("[data-after-intro]")).toHaveText("Nothing has started yet. Read what it will be told, then press Start agent.");
  });
});
