import { expect, test, type Page } from "@playwright/test";

const gh = (page: Page) => page.getByRole("listitem", { name: "GitHub" });
const setGithub = (page: Page, state: string) => page.evaluate((s) => (globalThis as unknown as { __gossamrFirstRun: { setGithub(s: string): void } }).__gossamrFirstRun.setGithub(s), state);

test.describe("the first-run screen", () => {
  test("shows who gh is signed in as and offers Connect Jira", async ({ page }) => {
    await page.goto("/?firstRun=ready");
    await expect(page.getByRole("heading", { name: "Connect your accounts" })).toBeVisible();
    await expect(gh(page)).toContainText("Authenticated · ada");
    await expect(gh(page)).toContainText("gh is signed in as ada on github.com");
    await expect(gh(page)).toContainText("Agents use this account to clone and push.");
    await expect(gh(page)).not.toContainText("reads GitHub");
    await expect(gh(page).locator("code")).toHaveCount(0);
    await expect(page.getByRole("listitem", { name: "Jira" })).toContainText("Not connected");
    await expect(page.getByRole("button", { name: "Connect Jira" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Connect Jira" })).toHaveCount(0);
  });

  test("shows the login command when gh has none, and picks up the login once it is run", async ({ page }) => {
    await page.goto("/?firstRun=notSignedIn");
    await expect(gh(page)).toContainText("Not signed in");
    await expect(gh(page)).toContainText("gh has no login on github.com.");
    await expect(gh(page).locator("code")).toHaveText("gh auth login -h github.com");

    await gh(page).getByRole("button", { name: "Open Terminal" }).click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { __gossamrFirstRun: { terminals(): string[] } }).__gossamrFirstRun.terminals()))
      .toEqual(["gh auth login -h github.com"]);

    await setGithub(page, "ready");
    await gh(page).getByRole("button", { name: "I've run it, check again" }).click();
    await expect(gh(page)).toContainText("Authenticated · ada");
    await expect(gh(page).locator("code")).toHaveCount(0);
  });

  test("shows how to install gh when it is missing", async ({ page }) => {
    await page.goto("/?firstRun=notFound");
    await expect(gh(page)).toContainText("Not found · gh");
    await expect(gh(page).locator("code")).toHaveText("brew install gh");
  });

  test("shows what went wrong with gh, with the command and a way to check again", async ({ page }) => {
    await page.goto("/?firstRun=error");
    await expect(gh(page).locator("code")).toHaveText("gh auth status");
    await expect(gh(page).getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(gh(page).getByRole("button", { name: "Open Terminal" })).toBeVisible();
    await setGithub(page, "ready");
    await gh(page).getByRole("button", { name: "I've run it, check again" }).click();
    await expect(gh(page)).toContainText("Authenticated · ada");
  });

  test("Connect Jira opens the form, and a connected token leaves for the workspace", async ({ page }) => {
    await page.goto("/?firstRun=ready&runs=empty");
    await page.getByRole("button", { name: "Connect Jira" }).click();
    const form = page.getByRole("form", { name: "Connect Jira" });
    await form.getByLabel("Your Jira site").fill("acme");
    await form.getByLabel("Your Atlassian email").fill("alf@acme.com");
    await form.getByLabel("API token").fill("token");
    await form.getByRole("button", { name: "Connect Jira" }).click();
    await expect(page).toHaveTitle("Work — Gossamr");
    await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("listitem", { name: "acme.atlassian.net connection" })).toContainText("Authenticated · Alf Henderson");
    await page.getByRole("button", { name: "+ Add" }).click();
    await expect(page.getByRole("menuitem", { name: /^GitHub account/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^Jira account/ })).toHaveCount(0);
  });

  test("Cancel closes the form, and sample data leaves for the workspace", async ({ page }) => {
    await page.goto("/?firstRun=ready&runs=empty");
    await page.getByRole("button", { name: "Connect Jira" }).click();
    await page.getByRole("form", { name: "Connect Jira" }).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("form", { name: "Connect Jira" })).toHaveCount(0);
    await page.getByRole("button", { name: "Try it with sample data" }).click();
    await expect(page).toHaveTitle("Work — Gossamr");
  });
});
