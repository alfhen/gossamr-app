import { expect, test } from "@playwright/test";
import { agentsSettled, homeConversation, homeConversationRegion, openApp, openPipHome, pipPane, startWorkstream, stepRail, workstreamRow, PIP_INPUT } from "./support/app";

test("a new workstream opens with one sentence and one action, with the commands behind the '?' button", async ({ page }) => {
  await openApp(page);
  await agentsSettled(page);
  await startWorkstream(page, "CA-401");
  const pane = pipPane(page);

  // One short sentence on what the workstream is for, and no commands in it.
  const intro = pane.locator("[data-empty-workstream]");
  await expect(intro).toHaveText(/^Everything for CA-401 .+ stays here: its agents, drafts and our conversation\.$/);
  const text = (await intro.textContent()) ?? "";
  expect(text.length).toBeLessThanOrEqual(140);
  expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1);
  await expect(pane.getByText("/stop R1")).toHaveCount(0);

  // The workstream's first suggestion is the intro's one primary action, not repeated as a chip.
  const primary = pane.getByRole("button", { name: "Investigate CA-401", exact: true });
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveAttribute("data-intro-action", "true");
  await expect(primary).toBeVisible();

  // The commands are a Tab away from the input, open with Enter and close with Esc, leaving the pane open.
  await page.locator(PIP_INPUT).focus();
  await page.keyboard.press("Tab");
  const help = pane.getByRole("button", { name: "Commands", exact: true });
  await expect(help).toBeFocused();
  await expect(help).toHaveText("?");
  await expect(help).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  const dialog = pane.getByRole("dialog", { name: "Commands" });
  await expect(dialog).toBeVisible();
  await expect(help).toHaveAttribute("aria-expanded", "true");
  for (const usage of ["/stop R1", "/retry R1", "/answer R1 your answer", "/hold", "/resume"]) await expect(dialog.getByText(usage, { exact: true })).toBeVisible();
  await expect(dialog).toContainText("R1 is a run in this workstream; a run's id works anywhere.");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(pane).toBeVisible();
  await expect(help).toBeFocused();
  // Space opens it as well.
  await page.keyboard.press(" ");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(pane).toBeVisible();

  // The primary action asks Pip what its chip would have asked.
  await primary.click();
  await expect(pane.locator("[data-user-bubble]").last()).toHaveText("Investigate CA-401");
  await expect(pane.locator("[data-empty-workstream]")).toHaveCount(0);
});

test("Pip home's Steps rail marks Investigate as next and keeps the later steps to one quiet line each", async ({ page }) => {
  await openApp(page);
  await agentsSettled(page);
  await startWorkstream(page, "CA-401");
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();
  await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 .* · Intake$/);

  // The same intro and single action as in the pane.
  const region = homeConversationRegion(page);
  await expect(region.locator("[data-empty-workstream]")).toHaveText(/^Everything for CA-401 /);
  await expect(region.getByRole("button", { name: "Investigate CA-401", exact: true })).toHaveCount(1);
  await expect(region.getByRole("button", { name: "Commands", exact: true })).toBeVisible();

  const rail = stepRail(page);
  const next = rail.locator('[data-step-next="investigate"]');
  await expect(next).toBeVisible();
  await expect(next).toContainText("Not started");
  await expect(rail.locator("[data-step-next]")).toHaveCount(1);
  const quiet = rail.locator("[data-step-quiet]");
  await expect(quiet).toHaveCount(5);
  expect(await quiet.evaluateAll((els) => els.map((el) => el.getAttribute("data-step-chip")))).toEqual(["triage", "plan", "build", "review", "verify"]);
  for (const box of await quiet.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeLessThan(30);
  await expect(quiet.getByText("Not started")).toHaveCount(0);

  // A quiet step still opens.
  const plan = rail.locator('[data-step-chip="plan"]');
  await plan.click();
  await expect(plan).toHaveAttribute("aria-expanded", "true");
  await expect(rail.locator('[data-step="plan"]')).toContainText("Nothing here yet.");
});
