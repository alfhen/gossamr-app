import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./support/app";

// The sentences the build is told before its plan, as PLAN_FOLLOW and PLAN_FOLLOW_UNEDITED in src-tauri/src/domain/run.rs.
const SETTLED = "A person read, edited and approved the plan below.";
const UNEDITED = "The plan below is the planning run's own answer. A person chose to build from it without settling it on the ticket first.";
const MARKER = "Marker: also check the unsubscribe link in all three emails.";

const peek = (page: Page) => page.locator("#peek-sheet");
const setup = (page: Page) => page.getByRole("dialog", { name: "Start an agent" });

/** Opens CA-401's peek. */
async function peekCa401(page: Page) {
  await page.getByRole("listbox", { name: "Items" }).getByText("CA-401", { exact: true }).click();
  await expect(peek(page)).toHaveAttribute("aria-label", "Details for CA-401");
}

/** From CA-401's done Plan run, chooses 'Build from this plan' and waits for the setup sheet. The first agent action of a fresh profile shows the safety sheet instead, once. */
async function buildFromPlan(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await peekCa401(page);
    await peek(page).getByRole("button", { name: /Welcome flow refresh Ready to review/ }).click();
    await page.getByRole("button", { name: "Build from this plan" }).click();
    const safety = page.getByRole("dialog", { name: "Agents safety and settings" });
    await expect(setup(page).or(safety)).toBeVisible();
    if (await safety.isVisible()) {
      await safety.getByRole("button", { name: "Close" }).click();
      continue;
    }
    break;
  }
  await expect(setup(page)).toBeVisible();
  await expect(setup(page).getByRole("textbox", { name: /^Plan from run / })).toBeVisible();
}

/** The whole prompt as the setup sheet shows it, and the plan part of it: from the sentence before the plan to its closing marker. */
async function prompt(page: Page) {
  const whole = setup(page).locator("details").filter({ hasText: "Show the whole prompt as one piece" });
  await whole.locator("summary").click();
  const text = (await whole.locator("pre").textContent()) ?? "";
  const close = text.indexOf("\nPLAN>>>");
  const open = text.lastIndexOf("\n\n", text.indexOf("\n\nPlan from run ") - 1);
  return { text, plan: open >= 0 && close > open ? text.slice(open + 2, close + "\nPLAN>>>".length) : "" };
}

test("a build from a plan nobody approved on the ticket says it follows the unedited plan", async ({ page }) => {
  await openApp(page);
  await buildFromPlan(page);
  const note = setup(page).getByRole("note").filter({ hasText: "follows the unedited plan" });
  await expect(note).toBeVisible();
  await expect(note).toContainText("the description draft that adds this plan to the ticket wasn't approved");
  await expect(note.getByRole("button", { name: "Read the plan again" })).toBeVisible();
  const { text, plan } = await prompt(page);
  expect(plan.startsWith(UNEDITED)).toBe(true);
  expect(plan).toContain("<<<PLAN\n## Approach");
  expect(text).not.toContain("edited and approved");
});

test("a build from a plan the person edited and approved on the ticket carries their text and no notice", async ({ page }) => {
  await openApp(page);
  await peekCa401(page);
  const draft = peek(page).getByRole("article", { name: "Update the description of CA-401" });
  await draft.getByRole("button", { name: "Edit" }).click();
  const body = draft.getByRole("textbox", { name: "New description, as Markdown" });
  await body.fill(`${await body.inputValue()}\n\n${MARKER}`);
  await draft.getByRole("button", { name: "Done editing" }).click();
  await draft.getByRole("button", { name: "Update description" }).click();
  await expect(draft).toHaveCount(0);
  await page.keyboard.press("Escape");

  await buildFromPlan(page);
  await expect(setup(page).getByRole("note").filter({ hasText: "follows the unedited plan" })).toHaveCount(0);
  await expect(setup(page)).toContainText("This build follows the plan from run");
  await expect(setup(page).getByRole("textbox", { name: /^Plan from run / })).toHaveValue(new RegExp(MARKER));
  const { plan } = await prompt(page);
  expect(plan.startsWith(SETTLED)).toBe(true);
  expect(plan).toContain(MARKER);
  expect(plan).not.toContain("Drafted by an agent run");
});
