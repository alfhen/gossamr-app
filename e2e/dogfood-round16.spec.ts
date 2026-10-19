import { expect, test } from "@playwright/test";
import { expandNeedsYou, needRow, needsPane, openApp, openPipHome, startWorkstream } from "./support/app";

const FIRST_RUN = { cookies: [], origins: [] };

// Fixes from the sixteenth dogfood round: a decision opened for one ticket does not stay over another workstream (G2); the glossary scrolls in a named list (G8).

test.describe("A decision stays with its workstream (G2)", () => {
  test("opening another workstream takes the open decision off the screen", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await expandNeedsYou(page, "General");
    await needRow(page, /DEVOPS-471.*asks to run a command/).click();
    await expect(needsPane(page)).toBeVisible();
    await page.locator('[data-workstream-row]:not([data-workstream-row="general"])').first().click();
    await expect(needsPane(page)).toHaveCount(0);
  });
});

test.describe("the glossary scrolls in a named list (G8)", () => {
  test.use({ storageState: FIRST_RUN });

  test("the expanded words are a focusable, named list that holds the scroll, not the card", async ({ page }) => {
    await page.goto("/?runs=empty");
    const card = page.locator("[data-pip-orientation]");
    await card.getByRole("button", { name: "What the words mean" }).click();
    const words = card.getByLabel("What the words mean", { exact: true });
    await expect(words).toHaveAttribute("tabindex", "0");
    await expect(words).toHaveCSS("overflow-y", "auto");
    await expect(card).not.toHaveCSS("overflow-y", "auto");
  });
});
