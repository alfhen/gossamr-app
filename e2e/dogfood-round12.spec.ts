import { expect, test } from "@playwright/test";
import { homeComposer, needsPane, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the twelfth dogfood round: unsent text kept per workstream (G1), Undo after Skip bringing back the edit (G2),
// the "may be unclear" notice coming back when the ask was skipped (G9).

test.describe("the composer per workstream (G1)", () => {
  test("keeps unsent text with its own workstream and never sends it from another", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await startWorkstream(page, "CA-402");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await homeComposer(page).fill("half a thought about 408");
    await workstreamRow(page, "CA-402").click();
    await expect(homeComposer(page)).toHaveValue("");
    await homeComposer(page).fill("something for 402");
    await workstreamRow(page, "CA-408").click();
    await expect(homeComposer(page)).toHaveValue("half a thought about 408");
    await workstreamRow(page, "CA-402").click();
    await expect(homeComposer(page)).toHaveValue("something for 402");
  });
});

test.describe("the ask of the reporter (G2, G9)", () => {
  test("skipping it brings the notice back, and Undo after Skip keeps what was typed", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openPipHome(page);
    await workstreamRow(page, "CA-408").click();
    await pipHome(page).locator("[data-clarity-notice]").getByRole("button", { name: "Ask the reporter now" }).click();
    const draft = needsPane(page).getByRole("article", { name: "Comment on CA-408" });
    await draft.getByRole("button", { name: "Edit" }).click();
    await needsPane(page).locator("textarea").first().fill("My own wording of the ask");
    await draft.getByRole("button", { name: "Skip" }).click();
    await expect(workstreamRow(page, "CA-408").locator("[data-status-detail]")).toHaveText("· may be unclear");
    await page.locator("[data-toast]").getByRole("button", { name: "Undo" }).click();
    // It comes back as a preview of what was typed (G26), and Edit opens the field with it.
    await expect(draft).toContainText("My own wording of the ask");
    await expect(needsPane(page).locator("textarea")).toHaveCount(0);
    await draft.getByRole("button", { name: "Edit" }).click();
    await expect(needsPane(page).locator("textarea").first()).toHaveValue("My own wording of the ask");
  });
});

test.describe("keyboard and screen reader (G5, G10, G14)", () => {
  test("closing a workstream puts the keyboard on General's row, and the conversation's name is a heading", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect(pipHome(page).getByRole("heading", { level: 2, name: /Workstream: CA-401/ })).toBeVisible();
    const controls = pipHome(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Close…" }).click();
    await controls.getByRole("button", { name: "Close workstream" }).click();
    await expect(pipHome(page).locator('[data-workstream-row="general"]')).toBeFocused();
    await expect(pipHome(page).getByRole("heading", { level: 2, name: "General" })).toBeVisible();
  });

  test("the palette offers Start a workstream… for 'start' and asks for the ticket", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("start");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("option", { name: /Start a workstream…/ }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Opens a workstream; starts no agent and posts nothing.")).toBeVisible();
  });
});
