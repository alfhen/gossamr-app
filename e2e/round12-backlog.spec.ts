import { expect, test, type Page } from "@playwright/test";
import {
  advanceRuns,
  agentsSettled,
  askPip,
  commentOnTicket,
  homeComposer,
  homeSettled,
  jiraWrites,
  mockRuns,
  needOfKind,
  needsPane,
  needsPaneHeading,
  needRow,
  openApp,
  openPipHome,
  paneSettled,
  pipHome,
  pipPane,
  startWorkstream,
  workstreamRow,
} from "./support/app";

// Backlog items of the twelfth dogfood round: what Pip is for and what the glossary is called (G21), the start review leading with
// what the agent may do (G22), one story of who posts (G23), the workstream controls explaining themselves (G24), a numbered reply
// quoted past its first line (G27), the Ctrl+0 note not queuing (G30), live regions said once (G31), names for a screen reader
// (G32), where F6 and Enter land and the plan's one Tab stop (G33), and the Needs you tag's verb (G34).

const port = Number(process.env.E2E_PORT ?? 4173);
/** A first run: nothing set aside, so the orientation card and Start my day show. */
const FIRST_RUN = { cookies: [], origins: [] };
/** The seeded profile without Start my day set aside, so its card (and Plan my week) show. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const MANAGED = "runs=empty&prSurface=manual&wsManage=1&pipPace=1";
const VAGUE = "CA-408";
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });
const safety = (page: Page) => page.getByRole("dialog", { name: "Agents safety and settings" });
const newest = async (page: Page, kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

/** Opens the setup sheet of Pip's investigation draft, past the one-time safety sheet. */
async function openSetup(page: Page, key: string) {
  await paneSettled(page);
  await askPip(page, "investigate this");
  await paneSettled(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await pipPane(page).getByRole("article", { name: `Start an agent: ${key}` }).last().getByRole("button", { name: "Review and start →" }).click();
    await expect(setup(page).or(safety(page))).toBeVisible();
    if (!(await safety(page).isVisible())) break;
    await safety(page).getByRole("button", { name: "Close" }).click();
  }
}

/** Moves run `id` on to done once Pip has answered. */
async function finish(page: Page, id: string) {
  await paneSettled(page);
  for (let i = 0; i < 3; i++) await advanceRuns(page, 1, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
}

/** A managed workstream on the vague ticket, its investigation and triage done: the reporter question waits. Left on Pip home. */
async function unclear(page: Page) {
  await openApp(page, MANAGED);
  await startWorkstream(page, VAGUE);
  await openSetup(page, VAGUE);
  await setup(page).getByRole("button", { name: "Start agent" }).click();
  await expect(setup(page)).toHaveCount(0);
  await finish(page, (await newest(page, "investigate"))!.id);
  await expect.poll(async () => (await newest(page, "triage"))?.id ?? null).not.toBeNull();
  await finish(page, (await newest(page, "triage"))!.id);
  await openPipHome(page);
  await workstreamRow(page, VAGUE).click();
  await expect(needOfKind(page, "readiness")).toBeVisible();
}

test.describe("what Pip is for, and what the glossary is called (G21)", () => {
  test.use({ storageState: FIRST_RUN });

  test("the New here card says what Pip does, and its glossary button is not another More", async ({ page }) => {
    await page.goto("/?runs=empty");
    const card = pipHome(page).locator("[data-pip-orientation]");
    await expect(card).toContainText("Pip works through your Jira tickets with coding agents and drafts every Jira and GitHub write for you to read and approve; nothing posts until you do.");
    await expect(card).toContainText("Gossamr posts only what you approve; a Build runs with your Claude settings and could reach Jira or GitHub on its own.");
    await expect(card.getByRole("button", { name: "More" })).toHaveCount(0);
    await card.getByRole("button", { name: "What the words mean" }).click();
    await expect(card).toContainText("One ticket's work from start to pull request");
  });
});

test.describe("the start review (G22, G23)", () => {
  test("leads with what the agent may do, and keeps the technical checks and the command under a closed Technical details", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, MANAGED);
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
    await openPipHome(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill("agents safety");
    await page.keyboard.press("Enter");
    const lines = safety(page).locator("[data-safety-summary] li");
    await expect(lines.nth(2)).toHaveText("Gossamr posts to Jira or GitHub only what you approve. A Build runs with your Claude settings and could reach Jira or GitHub on its own: your Claude settings, not Gossamr, decide that.");
  });
});

test.describe("the workstream controls (G24, G31, G32)", () => {
  test("say what Manage does in words, hint at Hold, Close and the menu, and say what the empty notes will hold", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await expect(controls.locator("[data-manage-state]")).toHaveText("off: Pip only answers");
    const manage = controls.getByRole("switch", { name: "Manage this workstream" });
    await expect(manage).toHaveAccessibleDescription(/Pip advises: it answers when asked/);
    await manage.click();
    await expect(controls.locator("[data-manage-state]")).toHaveText("on: Pip starts the next steps");
    await expect(manage).toHaveAccessibleDescription(/Pip manages: after each step finishes it starts the next one/);
    await expect(controls.getByRole("button", { name: "Hold" })).toHaveAccessibleDescription("No wakes and no automatic steps; its agents carry on");
    await expect(controls.getByRole("button", { name: "Close…" })).toHaveAccessibleDescription("Its conversation goes back to General; its agents and drafts are kept in General");
    await expect(controls.getByRole("button", { name: "More for this workstream" })).toHaveAccessibleDescription("More: stop the workstream");
    await expect(pipHome(page).getByRole("region", { name: "Pip's notes" })).toContainText("No notes yet. Pip writes here what it decides to remember about this workstream");
  });

  test("each message has one live region, and the timeline's rows name their ticket", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    // Opening a workstream announces nothing from the notice (G28); the live region only speaks when its line changes.
    await expect(pipHome(page).locator("[data-clarity-status]")).toHaveText("");
    const live = await page.locator('[role="status"], [aria-live]').evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()).filter(Boolean));
    expect(new Set(live).size).toBe(live.length);
    // The composer's footer is text, not a second announcer of what the toasts and the list already say.
    await expect(pipHome(page).locator("[data-composer-footer]")).not.toHaveAttribute("role", "status");
    await expect(pipHome(page).getByRole("listitem", { name: `${VAGUE}: You opened the workstream` })).toBeVisible();
  });
});

test.describe("an unclear ticket (G27, G32, G33, G34)", () => {
  test("a numbered reply is quoted on two lines with how many more, and the pane's link is a button that opens the workstream", async ({ page }) => {
    test.setTimeout(150_000);
    await unclear(page);
    await needOfKind(page, "readiness").click();
    await needsPane(page).getByRole("button", { name: "Ask the reporter" }).click();
    await needsPane(page).getByRole("article", { name: `Comment on ${VAGUE}` }).getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
    await commentOnTicket(page, VAGUE, "1. Send three emails\n2. Only to the winback list\n3. Not on Sundays");
    const need = needRow(page, "the reporter replied, plan now?");
    await need.click();
    const reply = needsPane(page).locator("[data-reporter-reply]");
    await expect(reply).toContainText("“1. Send three emails");
    await expect(reply).toContainText("2. Only to the winback list (+1 more)”");
    await expect(reply).not.toContainText("Not on Sundays");
    // The same quote in the timeline's row.
    await expect(pipHome(page).locator("[data-timeline-detail]").filter({ hasText: "(+1 more)" })).toHaveCount(1);
    // A button, not a link with a fake address; Enter on the row and F6 both land on the heading.
    const open = needsPane(page).getByRole("button", { name: "Open in workstream" });
    await expect(open).toBeVisible();
    await expect(needsPane(page).getByRole("link", { name: "Open in workstream" })).toHaveCount(0);
    await expect(needsPaneHeading(page)).toBeFocused();
    await homeComposer(page).focus();
    for (let i = 0; i < 8 && !(await needsPaneHeading(page).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("F6");
    await expect(needsPaneHeading(page)).toBeFocused();
  });

  test("the Needs you tag of a drafted agent says Review, as its button does", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, MANAGED);
    await agentsSettled(page, true);
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await askPip(page, "investigate this");
    await homeSettled(page);
    const row = needOfKind(page, "runStart");
    await expect(row).toHaveCount(1);
    await expect(row.locator("[data-needs-you-chip]")).toHaveText("Review");
  });
});

test.describe("Ctrl+0 while a message is typed (G30)", () => {
  test("its note comes up at once, not as +1 more behind an earlier toast", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await allProjects(page);
    await startWorkstream(page, VAGUE);
    await openPipHome(page);
    await workstreamRow(page, VAGUE).click();
    // An earlier note is on screen: the comment to the reporter is ready.
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    await expect(page.locator("[data-toast]")).toContainText("Here is the comment to the reporter");
    await homeComposer(page).fill("half a thought");
    await page.keyboard.press("ControlOrMeta+0");
    const toast = page.locator("[data-toast]");
    await expect(toast).toContainText("Ctrl+0 is off while Pip's composer holds a message; clear or send it first");
    await expect(toast).not.toContainText("more");
  });
});

test.describe("Plan my week's rows (G33)", () => {
  test.use({ storageState: DAY_DUE, viewport: { width: 1440, height: 900 } });

  test("are one Tab stop with the arrows and j and k inside, and the keys still move a row", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    const plan = pipHome(page).locator("[data-plan-my-week]");
    const picks = plan.locator("[data-plan-pick]");
    await expect(picks).toHaveCount(3);
    expect(await picks.evaluateAll((els) => els.map((e) => e.getAttribute("tabindex")))).toEqual(["0", "-1", "-1"]);
    await picks.first().focus();
    await page.keyboard.press("j");
    await expect(picks.nth(1)).toBeFocused();
    // The row the keyboard was on is the stop now, and its buttons with it; the others' buttons are out of the order.
    expect(await picks.evaluateAll((els) => els.map((e) => e.getAttribute("tabindex")))).toEqual(["-1", "0", "-1"]);
    await expect(picks.nth(0).locator("[data-plan-remove]")).toHaveAttribute("tabindex", "-1");
    await expect(picks.nth(1).locator("[data-plan-remove]")).not.toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("k");
    await expect(picks.first()).toBeFocused();
    const ids = await picks.evaluateAll((els) => els.map((e) => e.getAttribute("data-plan-pick")));
    await page.keyboard.press("Alt+ArrowDown");
    expect(await picks.evaluateAll((els) => els.map((e) => e.getAttribute("data-plan-pick")))).toEqual([ids[1], ids[0], ids[2]]);
  });
});
