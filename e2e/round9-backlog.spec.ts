import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, agentsHome, askPip, homeComposer, homeSettled, jiraWrites, mockRuns, needsPane, openAgents, openApp, paneSettled, pipPane, selectWorkstream, startWorkstream, openNeedOfKind, openNeedRow } from "./support/app";

// Fixes from round 9's backlog: the answers draft saying where it comes from (G20), the keyboard odds and ends (G21) and the
// pause quoting what tripped it (G23).

const toast = (page: Page) => page.locator("[data-toast]");
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

/** The questions to the reporter on `key`, drafted from its notice and left waiting in the decision pane. */
async function draftOn(page: Page, key: string) {
  await allProjects(page);
  await startWorkstream(page, key);
  await openAgents(page);
  await selectWorkstream(page, key);
  await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
  return needsPane(page).getByRole("article", { name: `Comment on ${key}` });
}

test.describe("the answers draft says which reply it came from (G20)", () => {
  /** Asks Pip for `what` on `key` and starts it, as the person does. */
  async function startStep(page: Page, what: string, key: string) {
    await paneSettled(page);
    await askPip(page, what);
    await paneSettled(page);
    const setup = page.getByRole("dialog", { name: "Start an agent" });
    await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup).toBeVisible();
    await setup.getByRole("button", { name: "Start agent" }).click();
    await expect(setup).toHaveCount(0);
  }
  const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
  async function finish(page: Page, id: string) {
    await paneSettled(page);
    for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
    await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
  }

  test("on its card in the app only, never in the comment that goes to Jira", async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page, "runs=empty&prSurface=manual&pipPace=1");
    await startWorkstream(page, "CA-408");
    await startStep(page, "investigate this", "CA-408");
    await finish(page, (await newest(page, "investigate"))!.id);
    await startStep(page, "triage this", "CA-408");
    await finish(page, (await newest(page, "triage"))!.id);
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await openNeedOfKind(page, "readiness");
    await needsPane(page).getByRole("button", { name: "I'll answer" }).click();
    await expect(homeComposer(page)).toHaveValue(/My answers: $/);
    await page.keyboard.type("1. Done means all three emails send. 2. Only the CRM export. 3. The support team.");
    await page.keyboard.press("Enter");
    await homeSettled(page);
    await openNeedRow(page, "Answers to the open questions");
    const card = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await expect(card).toContainText("Answers to the open questions on this ticket:");
    const line = card.locator('[data-provenance="pip"]');
    await expect(line).toContainText("Drafted by Pip");
    await expect(line).toContainText("Drafted from your reply “1. Done means all three emails send.");
    // What is posted is the answers alone.
    await card.getByRole("button", { name: "Edit" }).click();
    const text = await card.locator("textarea").first().inputValue();
    expect(text).toContain("Answers to the open questions on this ticket:");
    expect(text).not.toMatch(/Drafted|your reply|Pip/);
    await card.getByRole("button", { name: "Done editing" }).click();
    expect(await jiraWrites(page)).toEqual([]);
  });
});

test.describe("the keyboard odds and ends (G21)", () => {
  test("Esc on the Close confirm keeps the keyboard on Close… with a toast up", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(toast(page)).toContainText("Paused CA-401.");
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(controls.getByRole("button", { name: "Close…" })).toBeFocused();
  });
});

test.describe("the pause names what tripped it (G23)", () => {
  test("a broad mention as written, a secret masked to its first two characters", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    const pause = draft.locator("[data-post-pause]");
    const base = await needsPane(page).locator("textarea").count();
    expect(base).toBe(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    const original = await text.inputValue();
    await text.fill(`${original}\n\ncc @Everyone\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(pause).toContainText("Your edit mentions everyone");
    await expect(pause).toContainText("at “@Everyone”");
    await expect(pause).not.toContainText("hunter2");
    // Another edit takes the pause back; with only the password it quotes that, masked.
    await draft.getByRole("button", { name: "Keep editing" }).click();
    await text.fill(`${original}\n\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Done editing" }).click();
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(pause).toContainText("looks like a password, key or token at “hu…”");
    await expect(pause).not.toContainText("hunter2");
    expect(await jiraWrites(page)).toEqual([]);
  });
});
