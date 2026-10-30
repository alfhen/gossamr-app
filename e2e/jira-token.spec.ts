import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./support/app";

const TOKEN_LINK =
  "https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken&expiryDays=max&appId=jira&selectedScopes=%5B%22read%3Ajira-work%22%2C%22write%3Ajira-work%22%2C%22read%3Ajira-user%22%5D";

async function openSettings(page: Page) {
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

test.describe("a Jira token Jira turned down", () => {
  test("raises a banner whose button opens the Connect Jira sheet", async ({ page }) => {
    await openApp(page, "runs=empty&mockJiraToken=refused");
    const banner = page.getByRole("alert").filter({ hasText: "Jira turned down your token" });
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Make a new token" }).click();

    const sheet = page.getByRole("dialog", { name: "Connect Jira" });
    await expect(sheet).toBeVisible();
    for (const label of ["Your Jira site", "Your Atlassian email", "API token", "Token expires"]) await expect(sheet.getByLabel(label)).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Connect Jira" })).toBeDisabled();

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("Create token opens Atlassian's token page with the scopes filled in", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { opened: string[] }).opened = [];
      window.open = (url) => {
        (window as unknown as { opened: string[] }).opened.push(String(url));
        return null;
      };
    });
    await openApp(page, "runs=empty&mockJiraToken=refused");
    await page.getByRole("button", { name: "Make a new token" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect Jira" });
    await sheet.getByRole("button", { name: "Create token" }).click();
    expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([TOKEN_LINK]);
  });

  test("lists the scopes to tick when the page didn't fill in", async ({ page }) => {
    await openApp(page, "runs=empty&mockJiraToken=refused");
    await page.getByRole("button", { name: "Make a new token" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect Jira" });
    await expect(sheet.getByText("read:jira-work write:jira-work read:jira-user")).toHaveCount(0);
    await sheet.getByRole("button", { name: "The page didn't fill in" }).click();
    await expect(sheet.getByText("read:jira-work write:jira-work read:jira-user")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Copy scopes" })).toBeVisible();
  });
});

test.describe("a Jira token close to its expiry", () => {
  test("says how long is left in Settings, without a banner", async ({ page }) => {
    await openApp(page, "runs=empty&mockJiraToken=expiring");
    await openSettings(page);
    const sample = page.getByRole("listitem", { name: "Sample data connection" });
    await expect(sample.locator("[data-probe]")).toHaveAttribute("data-probe", "expiresSoon");
    await expect(sample).toContainText("Token expires in 9 days");
    await expect(page.getByRole("button", { name: "Make a new token" })).toHaveCount(0);
  });
});
