import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./support/app";

const QUERY = "runs=empty&mockRepos=6&providers=1&codex=1";

async function openSettings(page: Page) {
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

const rowOf = (page: Page, name: string) => page.getByRole("listitem", { name: `${name} connection` });
const terminals = (page: Page) => page.evaluate(() => (globalThis as unknown as { __gossamrMock: { connectionTerminals(): string[] } }).__gossamrMock.connectionTerminals());

async function openAddSheet(page: Page, driver: "Claude" | "Codex") {
  await page.getByRole("button", { name: "+ Add" }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${driver}`) }).click();
  const sheet = page.getByRole("dialog", { name: `Add ${driver}` });
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe("adding Claude and Codex", () => {
  test("adds a Claude with its own folder, signs it in from Terminal and shows it authenticated", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    const sheet = await openAddSheet(page, "Claude");
    await expect(sheet).toContainText("Each Claude has its own config folder");
    await expect(sheet.getByRole("button", { name: "Add Claude" })).toBeDisabled();
    await sheet.getByLabel("Name").fill("Claude work");
    await expect(sheet.getByRole("textbox", { name: /folder/i })).toHaveValue("~/.claude-work");
    await sheet.getByRole("button", { name: "Add Claude" }).click();

    await expect(sheet.getByRole("group", { name: "Sign in to Claude work" })).toContainText("Sign in as this Claude. Run this in Terminal, then check again.");
    await expect(sheet).toContainText("CLAUDE_CONFIG_DIR=~/.claude-work claude auth login");
    await expect(rowOf(page, "Claude work")).toContainText("Not signed in");

    await sheet.getByRole("button", { name: "I've run it, check again" }).click();
    await expect(sheet).toContainText("Sign in as this Claude");

    await sheet.getByRole("button", { name: "Open Terminal" }).click();
    await expect.poll(() => terminals(page)).toEqual(["CLAUDE_CONFIG_DIR=~/.claude-work claude auth login"]);
    await sheet.getByRole("button", { name: "I've run it, check again" }).click();
    await expect(sheet).toContainText("Authenticated · alf@acme.com");
    await expect(rowOf(page, "Claude work")).toContainText("Authenticated · alf@acme.com");

    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Claude work details" })).toBeVisible();
  });

  test("adds a Codex whose folder is its home and shows it authenticated with ChatGPT", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    const sheet = await openAddSheet(page, "Codex");
    await sheet.getByLabel("Name").fill("Codex side");
    await expect(sheet.getByRole("textbox", { name: /home/i })).toHaveValue("~/.codex-side");
    await sheet.getByRole("button", { name: "Add Codex" }).click();
    await expect(sheet).toContainText("CODEX_HOME=~/.codex-side codex login");
    await sheet.getByRole("button", { name: "Open Terminal" }).click();
    await sheet.getByRole("button", { name: "I've run it, check again" }).click();
    await expect(sheet).toContainText("Authenticated · ChatGPT");
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(rowOf(page, "Codex side")).toContainText("Authenticated · ChatGPT");
  });

  test("offers the usual setup only while no Claude uses it, and takes a folder the person types", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    const sheet = await openAddSheet(page, "Claude");
    await expect(sheet.getByRole("radio", { name: "My usual setup" })).toHaveCount(0);
    await sheet.getByLabel("Name").fill("Work");
    await sheet.getByRole("textbox", { name: /folder/i }).fill("~/elsewhere");
    await sheet.getByLabel("Name").fill("Work again");
    await expect(sheet.getByRole("textbox", { name: /folder/i })).toHaveValue("~/elsewhere");
  });

  test("shows why a folder is refused and keeps the sheet open", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    const sheet = await openAddSheet(page, "Claude");
    await sheet.getByLabel("Name").fill("Claude work");
    await sheet.getByRole("textbox", { name: /folder/i }).fill("~/.claude");
    await sheet.getByRole("button", { name: "Add Claude" }).click();
    await expect(sheet.getByRole("alert")).toContainText("usual setup");
    await expect(rowOf(page, "Claude work")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
  });

  test("closes the sheet on Escape and opens the same sheets from the palette", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    await openAddSheet(page, "Claude");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Add Claude" })).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill("Add Codex");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Add Codex" })).toBeVisible();
  });

  test("keeps Codex out of + Add unless the page asks for it", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6&providers=1");
    await openSettings(page);
    await page.getByRole("button", { name: "+ Add" }).click();
    const menu = page.getByRole("menu", { name: "Add a connection" });
    await expect(menu.getByRole("menuitem", { name: /^Claude/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Codex/ })).toHaveCount(0);
  });
});

test.describe("a provider's detail", () => {
  test("shows the account, folder, ignored shell key and what it is for, and shows the folder in Finder", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    const sheet = await openAddSheet(page, "Claude");
    await sheet.getByLabel("Name").fill("Claude personal");
    await sheet.getByRole("button", { name: "Add Claude" }).click();
    await sheet.getByRole("button", { name: "Done" }).click();

    const detail = page.getByRole("region", { name: "Claude personal details" });
    await expect(detail).toContainText("Not signed in");
    await expect(detail.getByText("claude auth login")).toBeVisible();
    await expect(detail).toContainText("~/.claude-personal");
    await expect(detail).toContainText("Your shell sets ANTHROPIC_API_KEY. Claude personal doesn't use it.");
    await expect(detail).toContainText("Pip and new agents run on Claude personal when you pick it. Agents already running keep going if you turn it off.");
    await detail.getByRole("button", { name: "Reveal in Finder" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(detail.getByRole("button", { name: /^Sync now|Manage/ })).toHaveCount(0);
  });

  test("says off in its own words, and the default Claude has no folder to show", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    await rowOf(page, "Claude").getByRole("switch", { name: "Claude" }).click();
    await rowOf(page, "Claude").locator("[data-connection]").click();
    const detail = page.getByRole("region", { name: "Claude details" });
    await expect(detail).toContainText("Off. Pip and new agents can't use it.");
    await expect(detail).toContainText("Your usual setup");
    await expect(detail.getByRole("button", { name: "Reveal in Finder" })).toHaveCount(0);
  });

  test("asks before removing a provider and says its login and folder stay", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    const sheet = await openAddSheet(page, "Claude");
    await sheet.getByLabel("Name").fill("Claude personal");
    await sheet.getByRole("button", { name: "Add Claude" }).click();
    await sheet.getByRole("button", { name: "Done" }).click();

    const detail = page.getByRole("region", { name: "Claude personal details" });
    await detail.getByRole("button", { name: "Remove" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Remove Claude personal" });
    await expect(confirm).toContainText("Gossamr stops offering it. Runs and Pip conversations that used it keep their history, and your login and folder stay as they are.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(rowOf(page, "Claude personal")).toBeVisible();
    await detail.getByRole("button", { name: "Remove" }).click();
    await confirm.getByRole("button", { name: "Yes, remove" }).click();
    await expect(rowOf(page, "Claude personal")).toHaveCount(0);
  });

  test("lets you add the usual setup again after the default is removed", async ({ page }) => {
    await openApp(page, QUERY);
    await openSettings(page);
    await rowOf(page, "Claude").locator("[data-connection]").click();
    await page.getByRole("region", { name: "Claude details" }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("alertdialog", { name: "Remove Claude" }).getByRole("button", { name: "Yes, remove" }).click();
    await expect(rowOf(page, "Claude")).toHaveCount(0);

    const sheet = await openAddSheet(page, "Claude");
    await sheet.getByLabel("Name").fill("Claude");
    await sheet.getByRole("radio", { name: "My usual setup" }).click();
    await sheet.getByRole("button", { name: "Add Claude" }).click();
    await expect(rowOf(page, "Claude")).toBeVisible();
  });
});
