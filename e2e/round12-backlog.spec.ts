import { expect, test, type Page } from "@playwright/test";
import { agentsHome, openAgents, openApp, pipPane, selectWorkstream, startWorkstream } from "./support/app";

// Backlog items of the twelfth dogfood round: one story of who posts (G23), the workstream controls explaining themselves (G24), the Ctrl+0 note not queuing (G30), live regions said once (G31),
// names for a screen reader (G32), where F6 and Enter land (G33).

const VAGUE = "CA-408";
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

test.describe("the safety sheet (G23)", () => {
  test("the safety sheet says Gossamr posts only what is approved, and a run with your Claude settings could reach Jira on its own", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openAgents(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agents safety");
    await page.keyboard.press("Enter");
    const lines = safety(page).locator("[data-safety-summary] li");
    await expect(lines.nth(2)).toHaveText("Gossamr posts to Jira or GitHub only what you approve. A Build runs with your Claude settings and could reach Jira or GitHub on its own: your Claude settings, not Gossamr, decide that.");
  });
});

test.describe("the workstream controls (G24, G31, G32)", () => {
  test("hint at Pause, Close and the menu, and say what the empty notes will hold", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, VAGUE);
    await openAgents(page);
    await selectWorkstream(page, VAGUE);
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await expect(controls.getByRole("button", { name: "Pause" })).toHaveAccessibleDescription("Pip isn't woken; its agents carry on");
    await expect(controls.getByRole("button", { name: "Close…" })).toHaveAccessibleDescription("Its conversation goes back to General; its agents and drafts are kept in General");
    await expect(controls.getByRole("button", { name: "More for this workstream" })).toHaveAccessibleDescription("More: stop the workstream");
    await expect(agentsHome(page).getByRole("region", { name: "Pip's notes" })).toContainText("No notes yet. Pip writes here what it decides to remember about this workstream");
  });
});
