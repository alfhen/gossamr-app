import { expect, test, type Page } from "@playwright/test";
import { openApp, reviewDrafts, reviewedDraft, toast } from "./support/app";

async function openSettings(page: Page) {
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

const rowOf = (page: Page, name: string) => page.getByRole("listitem", { name: `${name} connection` });
const refuseToken = (page: Page) => page.evaluate(() => (globalThis as unknown as { __gossamrMock: { refuseGithubToken(): void } }).__gossamrMock.refuseGithubToken());
const probe = (page: Page, state: string) => page.evaluate((s) => (globalThis as unknown as { __gossamrMock: { probeGithub(state: string): void } }).__gossamrMock.probeGithub(s), state);

test.describe("the Connections list", () => {
  test("shows one row for each connection with how it stands, and the detail of the first", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await expect(rowOf(page, "Sample data")).toContainText("Sample tickets");
    await expect(rowOf(page, "GitHub")).toContainText("Authenticated · ada");
    await expect(page.getByRole("region", { name: "Sample data details" })).toBeVisible();
    await expect(page.getByRole("region", { name: "GitHub details" })).toHaveCount(0);
  });

  test("opens the detail of the row you pick, with who drafts post as", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    const detail = page.getByRole("region", { name: "GitHub details" });
    await expect(detail).toContainText("gh is signed in as ada on github.com");
    await expect(detail).toContainText("Drafts post as ada via GitHub.");
    await expect(detail).toContainText("Agents clone and push as whichever account gh has active.");
    await expect(page.getByRole("region", { name: "Sample data details" })).toHaveCount(0);
  });

  test("moves between rows with the arrow keys", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await rowOf(page, "Sample data").getByRole("button").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("region", { name: "GitHub details" })).toBeVisible();
    await expect(rowOf(page, "GitHub").getByRole("button")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("region", { name: "Sample data details" })).toBeVisible();
  });

  test("follows the probe: the row and the detail change when gh stands differently", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    await probe(page, "notSignedIn");
    await expect(rowOf(page, "GitHub")).toContainText("Not signed in");
    await probe(page, "notFound");
    await expect(rowOf(page, "GitHub")).toContainText("Not found · gh");
    await probe(page, "off");
    await expect(rowOf(page, "GitHub")).toContainText("Off");
  });

  test("turns GitHub off from its row, says Off in the list and the detail, and turns it back on", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await expect(rowOf(page, "Sample data").getByRole("switch")).toHaveCount(0);
    const github = rowOf(page, "GitHub").getByRole("switch", { name: "GitHub" });
    await expect(github).toBeChecked();
    await github.click();
    await expect(github).not.toBeChecked();
    await expect(rowOf(page, "GitHub")).toContainText("Off");
    await expect(rowOf(page, "GitHub")).not.toContainText("Authenticated");
    await rowOf(page, "GitHub").getByRole("button").click();
    const detail = page.getByRole("region", { name: "GitHub details" });
    await expect(detail).toContainText("Gossamr doesn't sync it, Pip can't see it and drafts for it wait.");
    await expect(detail.getByRole("button", { name: "Sync now" })).toBeDisabled();
    await github.click();
    await expect(github).toBeChecked();
    await expect(rowOf(page, "GitHub")).toContainText("Authenticated · ada");
    await expect(detail.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  test("copies the command that fixes a connection", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page, "runs=empty&mockRepos=6&mockGithubProbe=notFound");
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    const detail = page.getByRole("region", { name: "GitHub details" });
    await detail.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("brew install gh");
  });

  test("opens Terminal on the command that fixes a connection", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6&mockGithubProbe=notSignedIn");
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    await page.getByRole("region", { name: "GitHub details" }).getByRole("button", { name: "Open Terminal" }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __gossamrMock: { connectionTerminals(): string[] } }).__gossamrMock.connectionTerminals())).toEqual(["gh auth login -h github.com"]);
  });

  test("renames a connection from its detail, and Cancel keeps the old name", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    const detail = page.getByRole("region", { name: "GitHub details" });
    await detail.getByRole("button", { name: "Rename" }).click();
    await detail.getByRole("textbox", { name: "Display name" }).fill("Work GitHub");
    await detail.getByRole("button", { name: "Cancel" }).click();
    await expect(rowOf(page, "GitHub")).toBeVisible();
    await expect(rowOf(page, "Work GitHub")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Work GitHub details" })).toHaveCount(0);
    await detail.getByRole("button", { name: "Rename" }).click();
    const name = detail.getByRole("textbox", { name: "Display name" });
    await name.fill("   ");
    await expect(detail.getByRole("button", { name: "Save" })).toBeDisabled();
    await name.fill("Work GitHub");
    await detail.getByRole("button", { name: "Save" }).click();
    await expect(rowOf(page, "Work GitHub")).toBeVisible();
    await expect(page.getByRole("region", { name: "Work GitHub details" })).toBeVisible();
  });

  test("checks every connection from the top and says when", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await page.getByRole("button", { name: "Check all" }).click();
    await expect(page.getByText("Checked just now").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Check all" })).toBeEnabled();
  });

  test("asks before it removes GitHub, says what is deleted, and Cancel leaves it connected", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    const detail = page.getByRole("region", { name: "GitHub details" });
    await expect(detail.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
    await detail.getByRole("button", { name: "Remove", exact: true }).click();
    const ask = page.getByRole("alertdialog", { name: "Remove GitHub" });
    await expect(ask).toContainText("deletes the pull requests and branches it cached for ada, forgets its token and closes the drafts that post as ada");
    await expect(ask).toContainText("Your gh login and GitHub stay as they are.");
    await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    await expect(rowOf(page, "GitHub")).toBeVisible();
  });

  test("removes GitHub: the row goes and the review draft that would post there is closed with a reason", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review).toBeVisible();
    await toast(page).getByRole("button", { name: "Dismiss" }).click();
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    await page.getByRole("region", { name: "GitHub details" }).getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Remove GitHub" }).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(rowOf(page, "GitHub")).toHaveCount(0);
    await expect(toast(page).filter({ hasText: "Removed GitHub." })).toBeVisible();
    expect((await reviewDrafts(page)).map((d) => d.state)).toEqual(["retired"]);
    await expect(rowOf(page, "Sample data")).toBeVisible();
  });

  test("opens the Connect GitHub sheet from the foot of the list, with the account already connected marked and the login command for another", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await page.getByRole("button", { name: "Connect another GitHub account" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect GitHub" });
    const accounts = sheet.getByRole("list", { name: "Accounts gh knows" });
    await expect(accounts).toContainText("ada");
    await expect(accounts).toContainText("Connected");
    await expect(sheet.getByRole("button", { name: "Connect ada" })).toHaveCount(0);
    await expect(sheet.getByText("gh auth login -h github.com")).toBeVisible();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toHaveCount(0);
  });

  test("connects the account gh holds from the sheet, with no token or code to enter", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openSettings(page);
    await expect(rowOf(page, "GitHub")).toHaveCount(0);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect GitHub" });
    await expect(sheet.getByRole("textbox")).toHaveCount(0);
    await expect(sheet.getByText("Active in gh")).toBeVisible();
    await sheet.getByRole("button", { name: "Connect ada" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(toast(page).filter({ hasText: "Connected to GitHub as ada." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose what to watch" })).toBeVisible();
  });

  test("signs a connected account in again from the sheet when GitHub turned its token down, and keeps its drafts", async ({ page }) => {
    const review = await reviewedDraft(page);
    await expect(review).toBeVisible();
    const before = (await reviewDrafts(page)).map((d) => d.state);
    await toast(page).getByRole("button", { name: "Dismiss" }).click();
    await refuseToken(page);
    const banner = page.getByRole("alert").filter({ hasText: "GitHub is signed out" });
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Open connections" }).click();
    const detail = page.getByRole("region", { name: "GitHub details" });
    await expect(detail).toContainText("GitHub no longer accepts the token for ada.");
    await detail.getByRole("button", { name: "Sign in again" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect GitHub" });
    await expect(sheet.getByRole("list", { name: "Accounts gh knows" })).toContainText("Signed out");
    await sheet.getByRole("button", { name: "Sign in again as ada" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await expect(detail).toContainText("gh is signed in as ada");
    expect((await reviewDrafts(page)).map((d) => d.state)).toEqual(before);
  });

  test("closes the sheet with Escape", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openSettings(page);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(page.getByRole("dialog", { name: "Connect GitHub" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Connect GitHub" })).toHaveCount(0);
  });

  test("says gh has no login, with the command to copy and open in Terminal", async ({ page }) => {
    await openApp(page, "runs=empty&mockGithubProbe=notSignedIn");
    await openSettings(page);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect GitHub" });
    await expect(sheet).toContainText("gh has no login on github.com.");
    await expect(sheet.getByRole("list", { name: "Accounts gh knows" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Open Terminal" }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __gossamrMock: { connectionTerminals(): string[] } }).__gossamrMock.connectionTerminals())).toEqual(["gh auth login -h github.com"]);
  });

  test("opens Terminal only on the login command, not on a fix the sheet shows for a gh that didn't answer", async ({ page }) => {
    await openApp(page, "runs=empty&mockGithubProbe=error");
    await openSettings(page);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect GitHub" });
    await expect(sheet.getByText("gh auth status", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Open Terminal" })).toHaveCount(0);
  });

  test("says gh isn't installed, with how to install it and no Terminal button", async ({ page }) => {
    await openApp(page, "runs=empty&mockGithubProbe=notFound");
    await openSettings(page);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect GitHub" });
    await expect(sheet).toContainText("gh isn't installed.");
    await expect(sheet.getByText("brew install gh")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Open Terminal" })).toHaveCount(0);
  });
});

test.describe("the banner for a signed-out connection", () => {
  test("names Jira and shows the row as not signed in", async ({ page }) => {
    await openApp(page, "runs=empty&mockJiraToken=refused");
    await expect(page.getByRole("alert").filter({ hasText: "Jira turned down your token" })).toBeVisible();
    await openSettings(page);
    await expect(rowOf(page, "Sample data")).toContainText("Not signed in");
  });

  test("names GitHub when gh has no login for it", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6&mockGithubProbe=notSignedIn");
    await expect(page.getByRole("alert").filter({ hasText: "GitHub is signed out" })).toBeVisible();
    await page.getByRole("alert").getByRole("button", { name: "Open connections" }).click();
    await expect(page.getByRole("region", { name: "GitHub details" })).toContainText("gh auth login -h github.com");
  });

  test("names GitHub when gh isn't installed", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6&mockGithubProbe=notFound");
    await expect(page.getByRole("alert").filter({ hasText: "GitHub is signed out" })).toBeVisible();
  });

  test("stays away when gh couldn't answer, because that is not a sign-out", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6&mockGithubProbe=error");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
