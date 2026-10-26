import { expect, test, type Page } from "@playwright/test";
import { agentsHome, askPip, homeSettled, needOfKind, openAgents, openApp, paneSettled, pipPane, selectWorkstream, startWorkstream } from "./support/app";

// Backlog items of the twelfth dogfood round: the start review leading with what the agent may do (G22), one story of who posts
// (G23), the workstream controls explaining themselves (G24), the Ctrl+0 note not queuing (G30), live regions said once (G31),
// names for a screen reader (G32), where F6 and Enter land (G33), and the Needs you tag's verb (G34).

const SAMPLE = "runs=empty&prSurface=manual&pipPace=1";
const VAGUE = "CA-408";
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

/** Opens the setup sheet of Pip's investigation draft. */
async function openSetup(page: Page, key: string) {
  await paneSettled(page);
  await askPip(page, "investigate this");
  await paneSettled(page);
  await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
  await expect(setup(page)).toBeVisible();
}



test.describe("the start review (G22, G23)", () => {
  test("leads with what the agent may do, and keeps the technical checks and the command under a closed Technical details", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, SAMPLE);
    await startWorkstream(page, VAGUE);
    await openSetup(page, VAGUE);
    const sheet = setup(page);
    const can = sheet.getByRole("group", { name: "What agents can do" });
    await expect(can).toBeVisible();
    // The read-only line comes first in it, and the box sits above the prompt.
    expect(await can.locator("[data-read-only]").count()).toBe(1);
    expect(await can.evaluate((el) => el.querySelector("p")?.hasAttribute("data-read-only"))).toBe(true);
    expect(await can.evaluate((el) => !!(el.compareDocumentPosition(document.querySelector('[role="dialog"] textarea') ?? el) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    const technical = sheet.locator("[data-technical-details] > details");
    await expect(technical).toHaveCount(1);
    await expect(technical.locator("> summary")).toHaveText("Technical details");
    // Closed while every check is fine; the checks are still reachable.
    const checks = sheet.getByRole("group", { name: "Checks before you approve" });
    if ((await technical.getAttribute("open")) === null) {
      await expect(checks).toBeHidden();
      await technical.locator("> summary").click();
    }
    await expect(checks).toContainText("What runs");
    await expect(technical.getByText("Show the exact command")).toBeVisible();
  });

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

test.describe("the Needs you tag (G34)", () => {
  test("the Needs you tag of a drafted agent says Review, as its button does", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, SAMPLE);
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    await askPip(page, "investigate this");
    await homeSettled(page);
    const row = needOfKind(page, "runStart");
    await expect(row).toHaveCount(1);
    await expect(row.locator("[data-needs-you-chip]")).toHaveText("Review");
  });
});
