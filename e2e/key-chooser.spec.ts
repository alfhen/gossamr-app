import { expect, type Page, test } from "@playwright/test";
import { openApp, openPip, peekSheet, peekTicket, pipPane, toast } from "./support/app";

/** CA-377 is a ticket only a sample run names, in a project both sample sites have. */
async function openByTypedKey(page: Page, before?: (page: Page) => Promise<void>) {
  await openApp(page, "jira=2");
  await before?.(page);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("CA-377");
  await palette.getByRole("option", { name: /Open CA-377/ }).click();
}

const chooser = (page: Page) => page.getByRole("dialog", { name: "Which CA-377" });

test.describe("a typed ticket key that two Jira sites could have", () => {
  test("asks which site, and reads the ticket from the one you pick", async ({ page }) => {
    await openByTypedKey(page);
    await expect(chooser(page)).toBeVisible();
    await expect(chooser(page).getByRole("listitem")).toHaveCount(2);
    await chooser(page).getByRole("button", { name: "Open CA-377 on acme.atlassian.net" }).click();
    await expect(chooser(page)).toHaveCount(0);
    await expect(peekSheet(page)).toHaveAttribute("data-item", "mock:CA-377");
  });

  test("looks in the other site when you pick it, and says when it isn't there", async ({ page }) => {
    await openByTypedKey(page);
    await chooser(page).getByRole("button", { name: "Open CA-377 on beta.atlassian.net" }).click();
    await expect(toast(page)).toContainText("Couldn't find CA-377");
    await expect(peekSheet(page)).toHaveCount(0);
  });

  test("opens nothing when you press Escape", async ({ page }) => {
    await openByTypedKey(page);
    await expect(chooser(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chooser(page)).toHaveCount(0);
    await expect(peekSheet(page)).toHaveCount(0);
  });

  test("takes Escape before the Pip pane behind it, which stays open", async ({ page }) => {
    await openByTypedKey(page, openPip);
    await expect(chooser(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chooser(page)).toHaveCount(0);
    await expect(pipPane(page)).toBeVisible();
  });

  test("takes Escape before an open peek, which stays open", async ({ page }) => {
    await openByTypedKey(page, (p) => peekTicket(p, "CA-401"));
    await expect(chooser(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chooser(page)).toHaveCount(0);
    await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for CA-401");
  });
});
