import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./support/app";

async function openSettings(page: Page) {
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

const rowOf = (page: Page, name: string) => page.getByRole("listitem", { name: `${name} connection` });
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
    await expect(detail).toContainText("Signed in as ada on github.com");
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

  test("checks every connection from the top and says when", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await page.getByRole("button", { name: "Check all" }).click();
    await expect(page.getByText("Checked just now").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Check all" })).toBeEnabled();
  });

  test("asks before it disconnects GitHub, and Cancel leaves it connected", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await rowOf(page, "GitHub").getByRole("button").click();
    await page.getByRole("region", { name: "GitHub details" }).getByRole("button", { name: "Disconnect" }).click();
    const ask = page.getByRole("alertdialog", { name: "Disconnect ada" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    await expect(rowOf(page, "GitHub")).toBeVisible();
  });

  test("connects another GitHub account from the foot of the list", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    await page.getByRole("button", { name: "Connect another GitHub account" }).click();
    await expect(page.getByRole("dialog", { name: "Connect GitHub" })).toBeVisible();
  });
});

test.describe("the banner for a signed-out connection", () => {
  test("names Jira and shows the row as not signed in", async ({ page }) => {
    await openApp(page, "runs=empty&mockJiraToken=refused");
    await expect(page.getByRole("alert").filter({ hasText: "Jira turned down your token" })).toBeVisible();
    await openSettings(page);
    await expect(rowOf(page, "Sample data")).toContainText("Not signed in");
  });

  test("stays away while gh is the only thing that is wrong with GitHub", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6&mockGithubProbe=notSignedIn");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
