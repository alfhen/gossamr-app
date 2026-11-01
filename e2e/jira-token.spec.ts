import { expect, test, type Page } from "@playwright/test";
import { expectToast, openApp } from "./support/app";

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

test.describe("connecting with a new token", () => {
  async function openSheet(page: Page) {
    await openApp(page, "runs=empty&mockJiraToken=refused");
    await page.getByRole("button", { name: "Make a new token" }).click();
    return page.getByRole("dialog", { name: "Connect Jira" });
  }

  test("checks the token, closes the sheet and clears the banner", async ({ page }) => {
    const sheet = await openSheet(page);
    await sheet.getByLabel("API token").fill("good-token");
    await sheet.getByRole("button", { name: "Connect Jira" }).click();
    await expect(sheet).toHaveCount(0);
    await expectToast(page, "Connected to Jira as Alf Henderson.");
    await expect(page.getByRole("alert").filter({ hasText: "Jira turned down your token" })).toHaveCount(0);
  });

  test("keeps the sheet open and says so when Jira refuses the token", async ({ page }) => {
    const sheet = await openSheet(page);
    await sheet.getByLabel("API token").fill("bad");
    await sheet.getByRole("button", { name: "Connect Jira" }).click();
    await expect(sheet.getByRole("alert")).toContainText("Jira didn't accept that email and token");
    await expect(sheet).toBeVisible();
  });

  test("asks for the cloud id only when the site won't give it", async ({ page }) => {
    const sheet = await openSheet(page);
    await sheet.getByLabel("Your Jira site").fill("unknown-site");
    await sheet.getByLabel("API token").focus();
    await expect(sheet.getByLabel("Cloud id")).toBeVisible();
  });

  test("does not close on Escape or a click outside while it is checking the token", async ({ page }) => {
    const sheet = await openSheet(page);
    await sheet.getByLabel("API token").fill("slow");
    await sheet.getByRole("button", { name: "Connect Jira" }).click();
    await expect(sheet.getByRole("button", { name: "Connecting…" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expectToast(page, "Connected to Jira as Alf Henderson.");
  });

  test("uses the cloud id of the site as it ends up, not of one corrected before the lookup answered", async ({ page }) => {
    const sheet = await openSheet(page);
    const site = sheet.getByLabel("Your Jira site");
    await site.fill("slow-first");
    await sheet.getByLabel("API token").focus();
    await site.fill("acme.atlassian.net");
    await sheet.getByLabel("API token").fill("good-token");
    await page.waitForTimeout(600);
    await sheet.getByRole("button", { name: "Connect Jira" }).click();
    await expect(sheet).toHaveCount(0);
    await expectToast(page, "Connected to Jira as Alf Henderson.");
  });
});

test.describe("a Jira token close to its expiry", () => {
  test("says how long is left in Settings, without a banner", async ({ page }) => {
    await openApp(page, "runs=empty&mockJiraToken=expiring");
    await expect(page.getByRole("alert").filter({ hasText: "Jira turned down your token" })).toHaveCount(0);
    await openSettings(page);
    await expect(page.getByRole("listitem", { name: "Sample data connection" })).toContainText("Token expires in 9 days");
    const detail = page.getByRole("region", { name: "Sample data details" });
    await expect(detail.locator("[data-probe]")).toHaveAttribute("data-probe", "expiresSoon");
    await expect(detail).toContainText("Your Jira token expires on 7 Nov. Make a new one and paste it here.");
    await detail.getByRole("button", { name: "Make a new token" }).click();
    await expect(page.getByRole("dialog", { name: "Connect Jira" })).toBeVisible();
  });
});

test.describe("adding Jira from + Add", () => {
  test("opens the Connect Jira sheet while no Jira is connected", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openSettings(page);
    await page.getByRole("button", { name: "+ Add" }).click();
    await page.getByRole("menuitem", { name: /^Jira account/ }).click();
    await expect(page.getByRole("dialog", { name: "Connect Jira" })).toBeVisible();
  });

  test("leaves Jira out of the menu once a token is connected", async ({ page }) => {
    await openApp(page, "runs=empty&mockJiraToken=refused");
    await page.getByRole("button", { name: "Make a new token" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect Jira" });
    await sheet.getByLabel("API token").fill("good-token");
    await sheet.getByRole("button", { name: "Connect Jira" }).click();
    await expect(sheet).toHaveCount(0);
    await openSettings(page);
    await page.getByRole("button", { name: "+ Add" }).click();
    await expect(page.getByRole("menuitem", { name: /^GitHub account/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^Jira account/ })).toHaveCount(0);
  });
});
