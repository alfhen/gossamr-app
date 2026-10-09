import { expect, test, type Page } from "@playwright/test";
import { askPip, openApp, openPip, pipPane } from "./support/app";

const peek = (page: Page) => page.locator("#peek-sheet");

/** Opens CA-401's peek. */
async function peekCa401(page: Page) {
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peek(page)).toHaveAttribute("aria-label", "Details for CA-401");
}

test("a draft a run left shows it was drafted by an agent and can still be approved", async ({ page }) => {
  await openApp(page);
  await peekCa401(page);
  // The description update CA-401's done Plan run left (seedPlanDescriptions in src/backend/mockRuns.ts).
  const draft = peek(page).getByRole("article", { name: "Update the description of CA-401" });
  await expect(draft).toBeVisible();
  const badge = draft.locator('[data-created-by="agent"]');
  await expect(badge).toHaveText("Drafted by an agent");
  await expect(draft.locator("[data-provenance=run]")).toContainText("From agent run");
  await expect(draft.getByRole("button", { name: "Update description" })).toBeEnabled();
});

test("a draft Pip made shows Proposed by Pip and no agent badge", async ({ page }) => {
  await openApp(page);
  await peekCa401(page);
  await openPip(page);
  await askPip(page, "investigate this");
  await expect(pipPane(page).getByRole("article", { name: "Start an agent: CA-401" })).toBeVisible();
  // The peek shows the draft in full, with who made it.
  const draft = peek(page).getByRole("article", { name: "Start an agent: CA-401" });
  await expect(draft).toBeVisible();
  await expect(draft).toContainText("Proposed by Pip");
  await expect(draft.locator('[data-created-by="agent"]')).toHaveCount(0);
  await expect(draft).not.toContainText("Drafted by an agent");
});
