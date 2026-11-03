import { expect, test, type Page } from "@playwright/test";
import { askPip, openApp, openPip, peekSheet, pipPane } from "./support/app";

const ACME = "acme.atlassian.net";
const BETA = "beta.atlassian.net";

const rows = (page: Page) => page.getByRole("listbox", { name: "Items" }).getByRole("option");
const row = (page: Page, key: string, site: string) => rows(page).filter({ hasText: key }).filter({ has: page.locator(`[data-site][title="Jira account: ${site}"]`) });
const accountFilter = (page: Page) => page.getByRole("combobox", { name: "Account" });

test.describe("several Jira accounts", () => {
  test("names the account on each row, and a ticket key both accounts have shows once for each", async ({ page }) => {
    await openApp(page, "runs=empty&jira=2");
    await expect(row(page, "CA-402", ACME)).toHaveCount(1);
    await expect(row(page, "CA-402", BETA)).toHaveCount(1);
    await expect(rows(page).first().locator("[data-site]")).toBeVisible();
  });

  test("shows no account chip with one account", async ({ page }) => {
    await openApp(page, "runs=empty");
    await expect(page.locator("[data-site]")).toHaveCount(0);
    await expect(accountFilter(page)).toHaveCount(0);
  });

  test("filters by each account and back to all", async ({ page }) => {
    await openApp(page, "runs=empty&jira=2");
    await accountFilter(page).selectOption({ label: BETA });
    await expect(row(page, "CA-402", BETA)).toHaveCount(1);
    await expect(row(page, "CA-402", ACME)).toHaveCount(0);
    await expect(page.locator(`[data-site][title="Jira account: ${ACME}"]`)).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Active filters" })).toContainText(`Account: ${BETA}`);

    await accountFilter(page).selectOption({ label: ACME });
    await expect(row(page, "CA-402", ACME)).toHaveCount(1);
    await expect(page.locator(`[data-site][title="Jira account: ${BETA}"]`)).toHaveCount(0);

    await accountFilter(page).selectOption({ label: "All accounts" });
    await expect(row(page, "CA-402", BETA)).toHaveCount(1);
    await expect(row(page, "CA-402", ACME)).toHaveCount(1);
  });

  test("opens a ticket from each account with its account in the peek", async ({ page }) => {
    await openApp(page, "runs=empty&jira=2");
    await row(page, "CA-402", BETA).click();
    await expect(peekSheet(page)).toHaveAttribute("data-item", "mock2:CA-402");
    await expect(peekSheet(page).locator("[data-site]")).toHaveText(BETA);
    await row(page, "CA-402", ACME).click();
    await expect(peekSheet(page)).toHaveAttribute("data-item", "mock:CA-402");
    await expect(peekSheet(page).locator("[data-site]")).toHaveText(ACME);
  });

  test("names the site on rail projects that share a key", async ({ page }) => {
    await openApp(page, "runs=empty&jira=2");
    const projects = page.getByRole("group", { name: "Projects" });
    await expect(projects.getByRole("button", { name: `Campaigns · ${ACME}` })).toBeVisible();
    await expect(projects.getByRole("button", { name: `Client campaigns · ${BETA}` })).toBeVisible();
    await expect(projects.getByRole("button", { name: "Operations" })).toBeVisible();
  });

  test("keeps Pip's General for the account picked in the drawer, with no ticket open", async ({ page }) => {
    await openApp(page, "runs=empty&jira=2");
    await openPip(page);
    const control = pipPane(page).getByRole("combobox", { name: "Pip works in" });
    await expect(control).toHaveValue("mock");
    await control.selectOption({ label: BETA });
    await askPip(page, "What is on my plate?");
    await expect(pipPane(page).getByText("What is on my plate?")).toBeVisible();
    await expect(pipPane(page).locator('[data-turn-kind="user"][data-turn-status="done"]')).toHaveCount(1);

    await control.selectOption({ label: ACME });
    await expect(pipPane(page).getByText("What is on my plate?")).toHaveCount(0);
    await control.selectOption({ label: BETA });
    await expect(pipPane(page).getByText("What is on my plate?")).toBeVisible();
  });

  test("offers no drawer control while a ticket is open", async ({ page }) => {
    await openApp(page, "runs=empty&jira=2");
    await row(page, "CA-402", BETA).click();
    await openPip(page);
    await expect(pipPane(page).getByRole("combobox", { name: "Pip works in" })).toHaveCount(0);
  });
});
