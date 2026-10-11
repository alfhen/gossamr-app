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
  // Named by ticket and step, never by the run's id, and the name opens the run.
  const from = draft.locator("[data-provenance=run]");
  await expect(from).toContainText("From the CA-401 plan");
  await expect(from).not.toContainText(/\b[0-9a-f]{8}\b/);
  await expect(draft.getByRole("button", { name: "Update description" })).toBeEnabled();
  await from.getByRole("button", { name: "the CA-401 plan" }).click();
  await expect(page.getByRole("dialog", { name: "Agent run" })).toBeVisible();
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
