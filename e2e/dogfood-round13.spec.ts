import { expect, test } from "@playwright/test";
import { agentsHome, needsPane, openAgents, openApp, pipPane, selectWorkstream, startMyDay, startWorkstream } from "./support/app";

// Fixes from the thirteenth dogfood round: the reporter's questions no longer claim work has not started (G12), and the
// "Done: … Now: …" line goes when Undo brings the skipped draft back (G11), the comment draft's edit field and provenance
// (G4), the toast's live region (G5), where the keyboard lands after Ask the reporter now (G6), F6 in Plan my week's field
// (G7) and the palette's focus (G8).

test.describe("the ask of the reporter (G11, G12)", () => {
  test("is worded for a ticket that may already have work, and Undo after Skip takes the Done line away", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await startWorkstream(page, "CA-402");
    await openAgents(page);
    await selectWorkstream(page, "CA-402");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: /^Comment on CA-/ });
    await expect(draft).toContainText(/A few things need clearing up to make this ticket clear to work on/);
    await expect(draft).not.toContainText("Before work on");
    await draft.getByRole("button", { name: "Skip" }).click();
    await expect(page.locator("[data-toast]").getByRole("button", { name: "Undo" })).toBeVisible();
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("[data-needs-advanced]")).toHaveCount(0);
  });
});

const port = Number(process.env.E2E_PORT ?? 4173);
const DAY_DUE = { cookies: [], origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: "gossamr-prefs", value: JSON.stringify({ pipOrientationSeen: true, permissionExplainerSeen: true }) }] }] };

test.describe("the reporter's comment draft for a keyboard and a screen reader (G4, G5, G6)", () => {
  test("takes the keyboard on its card, names its edit field, keeps the provenance words apart and the toast's live region to its message", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    await agentsHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: /^Comment on CA-408/ });
    // In the decision that shows it, not on the Manage switch, which Space would flip.
    await expect(needsPane(page).locator(":focus")).toHaveCount(1);
    await expect(page.locator('[role="switch"]:focus')).toHaveCount(0);
    await expect(draft).toContainText("Drafted by Gossamr Gossamr wrote");
    await draft.getByRole("button", { name: "Edit" }).click();
    await expect(draft.getByRole("combobox", { name: /Edit the comment on CA-408/ })).toBeVisible();
    await draft.getByRole("button", { name: "Skip" }).click();
    const live = page.locator("[data-toast-status]");
    await expect(live).toHaveAttribute("role", "status");
    const message = (await live.textContent()) ?? "";
    expect(message.length).toBeGreaterThan(0);
    expect(await page.locator('[role="status"]:has([data-toast-action])').count()).toBe(0);
    await expect(page.locator("[data-toast]").getByRole("button", { name: /^Undo[^:]*: / })).toBeVisible();
    expect(await page.locator("[data-toast] > span").first().textContent()).toBe(message);
  });
});

test.describe("F6 in Plan my week's field (G7)", () => {
  test.use({ storageState: DAY_DUE, viewport: { width: 1440, height: 900 } });

  test("steps to another region instead of being kept by the add field", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await openAgents(page);
    await startMyDay(page);
    await agentsHome(page).locator("[data-start-my-day]").getByRole("button", { name: "Plan my week" }).click();
    const add = agentsHome(page).locator("[data-plan-add]");
    await add.focus();
    await page.keyboard.press("F6");
    await expect(add).not.toBeFocused();
  });
});

test.describe("the palette's focus (G8)", () => {
  test.use({ storageState: DAY_DUE });

  test("stays in the search through a mouse pick of Start a workstream…, and What Jira saw from me opens on its heading", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("start");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("option", { name: /Start a workstream…/ }).click();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("What Jira saw");
    await dialog.getByRole("option", { name: /What Jira saw from me/ }).click();
    await expect(page.locator("[data-jira-sent]").getByRole("heading", { level: 1, name: "What Jira saw from me" })).toBeFocused();
  });
});

test.describe("the keyboard after the Investigate chip (G6)", () => {
  test("does not fall to the page when the chip goes", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-402");
    await openAgents(page);
    await selectWorkstream(page, "CA-402");
    const chip = pipPane(page).getByRole("button", { name: "Investigate CA-402", exact: true });
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveCount(0);
    for (let i = 0; i < 10; i++) {
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
      await page.waitForTimeout(200);
    }
  });
});
