import { expect, test, type Page } from "@playwright/test";
import { jiraWrites, needsPane, openAgents, openApp, pipCommentDraft, pipPane, selectWorkstream, startWorkstream, stepChip } from "./support/app";

// Backlog items of the sixteenth dogfood round: what Close does to agents (G24), the posting pause naming its line (G33),
// Pause and the other controls drawn as buttons (G30) and every step stating its state (G34).

/** A comment on CA-408 drafted by Pip: a workstream on it, Pip asked for a comment, its card in the decision pane. */
async function commentDraft(page: Page) {
  await openApp(page, "runs=empty");
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
  await startWorkstream(page, "CA-408");
  await openAgents(page);
  await selectWorkstream(page, "CA-408");
  const draft = await pipCommentDraft(page, "CA-408");
  await expect(draft).toBeVisible();
  return draft;
}

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

  test("the pause names the line of a secret in the draft", async ({ page }) => {
    test.setTimeout(120_000);
    const draft = await commentDraft(page);
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

