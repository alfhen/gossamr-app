import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./support/app";

async function openSettings(page: Page) {
  await page.locator("aside", { has: page.getByRole("navigation", { name: "Workspace" }) }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  return page.getByRole("listitem", { name: "GitHub account ada" });
}

/** Has the sample GitHub probe find `state`, as Rust's `connections` event would announce it. */
const probe = (page: Page, state: string) => page.evaluate((s) => (globalThis as unknown as { __gossamrMock: { probeGithub(state: string): void } }).__gossamrMock.probeGithub(s), state);

test.describe("GitHub's status in Settings", () => {
  test("shows each way gh can stand, with the command that fixes it, as the probe finds it", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    const card = await openSettings(page);
    await expect(card.locator("[data-probe]")).toHaveAttribute("data-probe", "ready");
    await expect(card).toContainText("gh is signed in as ada on github.com");

    await probe(page, "notSignedIn");
    await expect(card.locator("[data-probe]")).toHaveAttribute("data-probe", "notSignedIn");
    await expect(card).toContainText("gh has no login for ada on github.com.");
    await expect(card.locator("code")).toHaveText("gh auth login -h github.com");

    await probe(page, "notFound");
    await expect(card).toContainText("gh isn't installed.");
    await expect(card.locator("code")).toHaveText("brew install gh");

    await probe(page, "error");
    await expect(card).toContainText("Keychain");
  });

  test("starts on what the probe found before the page opened", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6&mockGithubProbe=notFound");
    const card = await openSettings(page);
    await expect(card.locator("[data-probe]")).toHaveAttribute("data-probe", "notFound");
  });

  test("Check again asks once more and leaves the button ready", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    const card = await openSettings(page);
    await expect(card).toContainText("Checked just now");
    await card.getByRole("button", { name: "Check again" }).click();
    await expect(card.locator("[data-probe]")).toHaveAttribute("data-probe", "ready");
    await expect(card.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  test("the sample connection shows no probe", async ({ page }) => {
    await openApp(page, "runs=empty&mockRepos=6");
    await openSettings(page);
    const sample = page.getByRole("listitem", { name: "Sample data connection" });
    await expect(sample).toBeVisible();
    await expect(sample.locator("[data-probe]")).toHaveCount(0);
  });
});
