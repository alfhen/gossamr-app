import { expect, test } from "@playwright/test";
import { agentsHome, openAgents, openApp, openPip, pipPane } from "./support/app";

test.describe("Esc in Settings", () => {
  test("Esc leaves Settings for Pip home, from <body>", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, "runs=empty");
    await openAgents(page);
    await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toHaveCount(0);
    await expect(agentsHome(page)).toBeVisible();
  });
});

test.describe("Settings", () => {
  test("has one notifications setting, on or off, and no digest", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openAgents(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agent settings");
    await page.keyboard.press("Enter");
    const safety = page.getByRole("dialog", { name: "Agent settings" });
    const notifications = safety.getByRole("checkbox", { name: "Notifications" });
    await expect(notifications).toBeChecked();
    await expect(safety.getByText(/digest/i)).toHaveCount(0);
    await notifications.uncheck();
    await expect(notifications).not.toBeChecked();
    await notifications.check();
    await expect(notifications).toBeChecked();
    await notifications.uncheck();
    await expect(notifications).not.toBeChecked();
    // Saved, not only drawn: closing the dialog and opening it again reads the stored value.
    await page.keyboard.press("Escape");
    await expect(safety).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox").fill("agent settings");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Agent settings" }).getByRole("checkbox", { name: "Notifications" })).not.toBeChecked();
  });
});

test.describe("Inbox", () => {
  test("is one list of watched-ticket activity with one Mentions filter", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Inbox(,|$)/ }).click();
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    const feed = page.getByRole("feed", { name: "Inbox" });
    await expect(feed.locator("article").first()).toBeVisible();
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button")).toHaveCount(1);
    const all = await feed.locator("article").count();
    await show.getByRole("button", { name: "Mentions" }).click();
    await expect(show.getByRole("button", { name: "Mentions" })).toHaveAttribute("aria-pressed", "true");
    await expect(feed.locator("article").first()).toContainText("mentioned you on");
    expect(await feed.locator("article").count()).toBeLessThan(all);
    await show.getByRole("button", { name: "Mentions" }).click();
    await expect(feed.locator("article")).toHaveCount(all);
  });

  test("marks an entry read, and all of them", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Inbox(,|$)/ }).click();
    const feed = page.getByRole("feed", { name: "Inbox" });
    const unread = feed.locator('article[data-unread="true"]');
    const first = await unread.count();
    expect(first).toBeGreaterThan(1);
    await unread.first().getByRole("button", { name: "Mark read" }).click();
    await expect(unread).toHaveCount(first - 1);
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(unread).toHaveCount(0);
  });
});

test("Settings states what Gossamr posts and what agents may do, and Work does not", async ({ page }) => {
  await openApp(page, "runs=empty");
  await openAgents(page);
  await expect(page.locator("body")).not.toContainText("until you approve it");
  await expect(page.locator("body")).not.toContainText("Claude Code settings");
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  const promises = page.locator("[data-promises] li");
  await expect(promises).toHaveText(["Gossamr posts nothing to Jira or GitHub until you approve it.", "Agents run with your own Claude Code settings, so they can push branches and use your own tools."]);
});

test("the theme control moves with the arrow keys and Space flips the Follow my screen switch", async ({ page }) => {
  await openApp(page, "runs=empty");
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  const checked = theme.getByRole("radio", { checked: true });
  const first = await checked.textContent();
  await checked.focus();
  await page.keyboard.press("ArrowRight");
  await expect(theme.getByRole("radio", { checked: true })).not.toHaveText(first ?? "");
  await expect(theme.getByRole("radio", { checked: true })).toBeFocused();

  await openPip(page);
  await pipPane(page).locator('button[aria-controls="pip-seeing"]').click();
  const follow = pipPane(page).getByRole("switch", { name: "Follow my screen" });
  const before = await follow.getAttribute("aria-checked");
  await follow.focus();
  await page.keyboard.press("Space");
  await expect(follow).not.toHaveAttribute("aria-checked", before ?? "");
});
