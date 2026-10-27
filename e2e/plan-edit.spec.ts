import { expect, test } from "@playwright/test";
import { mockRuns, openApp, startAgent } from "./support/app";

const MARKER = "Marker: also check the unsubscribe link in all three emails.";

const peek = (page: import("@playwright/test").Page) => page.locator("#peek-sheet");

/** Opens CA-401's peek. */
async function peekCa401(page: import("@playwright/test").Page) {
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peek(page)).toHaveAttribute("aria-label", "Details for CA-401");
}

test("a build from a plan the person edited and approved on the ticket carries their text", async ({ page }) => {
  await openApp(page);
  await peekCa401(page);
  const draft = peek(page).getByRole("article", { name: "Update the description of CA-401" });
  await draft.getByRole("button", { name: "Edit" }).click();
  const body = draft.getByRole("textbox", { name: "New description, as Markdown" });
  // The person's line goes at the end of the plan, inside its Gossamr Plan expand.
  await body.fill((await body.inputValue()).replace(/\n*<\/details>\s*$/, `\n\n${MARKER}\n\n</details>`));
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  // On the ticket the plan is one folded line: a collapsed details with the summary "Gossamr Plan".
  const folded = peek(page).locator("details").filter({ has: page.locator("summary", { hasText: /^Gossamr Plan$/ }) });
  await expect(folded).toHaveCount(1);
  expect(await folded.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
  await page.keyboard.press("Escape");

  const plan = (await mockRuns(page)).find((r) => r.kind === "plan" && r.key === "CA-401")!;
  const id = await startAgent(page, "CA-401", "build", { fromRun: plan.id });
  await page.getByRole("button", { name: /^Agents/ }).click();
  await page.locator(`main article[data-run-id="${id}"]`).first().click();
  const told = page.locator("#agent-sheet").locator("details").filter({ hasText: "What the agent was told" });
  await told.locator("> summary").first().click();
  await expect(told.locator("[data-plan]")).toContainText(MARKER);
});
