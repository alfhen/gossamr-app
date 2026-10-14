import { expect, test, type Page } from "@playwright/test";
import { jiraWrites, needsPane, needsYouCount, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from round 8's backlog: the workstream step says why a key has nothing to start, a pause before posting edited text that
// reaches everyone or looks like a secret, Close beside Hold, and the Plan my week add box naming a Done ticket.

const port = Number(process.env.E2E_PORT ?? 4173);
/** The seeded profile (e2e/playwright.config.ts) without Start my day set aside, so its card shows. */
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

const allProjects = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();

test.describe("the workstream step with nothing to start (G16)", () => {
  test("says why a typed key has no ticket to start a workstream on", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).getByRole("button", { name: "Start a workstream…" }).click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("CA-9999");
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await expect(dialog).toContainText("No open ticket CA-9999 here. It may be Done, already have a workstream, or not be loaded.");
  });
});

test.describe("the pause before posting edited text (G19)", () => {
  /** The questions to the reporter on CA-408, drafted from its notice and left waiting. */
  async function draftOn(page: Page, key: string) {
    await allProjects(page);
    await startWorkstream(page, key);
    await openPipHome(page);
    await workstreamRow(page, key).click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    return needsPane(page).getByRole("article", { name: `Comment on ${key}` });
  }
  const addLine = async (page: Page, draft: ReturnType<Page["locator"]>, line: string) => {
    await draft.getByRole("button", { name: "Edit" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill(`${await text.inputValue()}\n\n${line}`);
    await draft.getByRole("button", { name: "Done editing" }).click();
  };

  test("an edit that mentions everyone or holds a password waits for a second press, and is never blocked", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await addLine(page, draft, "cc @everyone\nPassword: hunter2");
    await draft.getByRole("button", { name: "Post comment" }).click();
    const pause = draft.locator("[data-post-pause]");
    await expect(pause).toContainText("Your edit mentions everyone");
    await expect(pause).toContainText("looks like a password, key or token");
    expect(await jiraWrites(page)).toEqual([]);
    // The person can pass it.
    await draft.getByRole("button", { name: "Post anyway" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
  });

  test("an edit that only mentions a person posts at once, and editing again takes the pause back", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    const draft = await draftOn(page, "CA-408");
    await addLine(page, draft, "cc @everyone");
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    await draft.getByRole("button", { name: "Keep editing" }).click();
    const text = needsPane(page).locator("textarea").first();
    await text.fill((await text.inputValue()).replace("cc @everyone", "cc @Mette Lund"));
    await draft.getByRole("button", { name: "Done editing" }).click();
    await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
    await draft.getByRole("button", { name: "Post comment" }).click();
    await expect.poll(async () => (await jiraWrites(page)).length).toBe(1);
  });
});

test.describe("Close beside Hold (G21)", () => {
  test("an idle workstream's controls show Close, which asks before closing", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await expect(controls.getByRole("button", { name: "Hold", exact: true })).toBeVisible();
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask).toContainText("its agents and drafts are kept");
    // Keep takes it back; Close goes through.
    await ask.getByRole("button", { name: "Keep" }).click();
    await expect(ask).toHaveCount(0);
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(workstreamRow(page, "CA-401")).toHaveCount(0);
    await expect(needsYouCount(page)).toHaveText("0");
  });
});

test.describe("adding a Done ticket to the plan (G24)", () => {
  test.use({ storageState: DAY_DUE });

  test("says the ticket is Done in Jira, not that none matches", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openPipHome(page);
    await pipHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    const plan = pipHome(page).locator("[data-plan-my-week]");
    await plan.locator("[data-plan-add]").fill("DEVOPS-478");
    await plan.locator("[data-plan-add-go]").click();
    await expect(plan.locator("[data-plan-missing]")).toHaveText("DEVOPS-478 is Done in Jira.");
    await plan.locator("[data-plan-add]").fill("CA-999");
    await plan.locator("[data-plan-add-go]").click();
    await expect(plan.locator("[data-plan-missing]")).toHaveText("No open ticket matches that.");
    expect(await jiraWrites(page)).toEqual([]);
  });
});
