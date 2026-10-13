import { expect, test, type Page } from "@playwright/test";
import { askPermission, askPip, expandNeedsYou, expectToast, homeConversation, homeSettled, mockRuns, needOfKind, needRow, needsPane, needsYouTray, openApp, openPipHome, pipHome, startWorkstream, workstreamRow } from "./support/app";

// Fixes from the fourth dogfood round: Deny asks before it tells the agent no, Needs-you titles wrap instead of
// truncating, and the Decisions count leaves out bookkeeping.

const stateOf = async (page: Page, id: string) => (await mockRuns(page)).find((r) => r.id === id)?.state;

/** Pip home on the sample's own runs, with the permission need's decision open in the pane. */
async function onPermission(page: Page) {
  await openApp(page);
  await openPipHome(page);
  await expect(needsYouTray(page)).toBeVisible();
  await expandNeedsYou(page, "General");
  const run = (await mockRuns(page)).find((r) => r.key === "DEVOPS-471")!;
  await needRow(page, /DEVOPS-471.*asks to run a command/).click();
  const pane = needsPane(page);
  await expect(pane.locator("[data-permission-ask]")).toBeVisible();
  return { run, pane };
}

test.describe("Deny on a permission prompt asks first (F1)", () => {
  test("one click only asks; Keep waiting and Escape leave the run waiting; Yes, deny goes through and says so", async ({ page }) => {
    const { run, pane } = await onPermission(page);
    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    const confirm = pane.getByRole("group", { name: "Deny this request" });
    await expect(confirm).toContainText("Tell Claude no? It carries on without it.");
    expect(await stateOf(page, run.id)).toBe("needsPermission");

    await confirm.getByRole("button", { name: "Keep waiting" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await stateOf(page, run.id)).toBe("needsPermission");

    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await stateOf(page, run.id)).toBe("needsPermission");

    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    await confirm.getByRole("button", { name: "Yes, deny" }).click();
    await expect.poll(() => stateOf(page, run.id)).toBe("working");
    await expectToast(page, /^Denied\. .+ carries on without it\./);
  });

  test("an open Deny confirm closes when the run asks for something else, so it can't deny the new request", async ({ page }) => {
    const { run, pane } = await onPermission(page);
    await pane.getByRole("button", { name: "Deny", exact: true }).click();
    const confirm = pane.getByRole("group", { name: "Deny this request" });
    await expect(confirm).toBeVisible();
    await askPermission(page, run.id, "approve Bash: git status");
    await expect(pane.locator("[data-permission-ask]")).toContainText("git status");
    await expect(confirm).toHaveCount(0);
    expect(await stateOf(page, run.id)).toBe("needsPermission");
  });
});

test.describe("Needs-you titles wrap (F10)", () => {
  test("a need's title may take two lines instead of truncating, and the header stays in view", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    await expandNeedsYou(page, "General");
    const title = needsYouTray(page).locator("[data-needs-you-need-title]").first();
    await expect(title).toBeVisible();
    expect(await title.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");
    expect(await title.getAttribute("title")).toBeTruthy();
    expect(await needsYouTray(page).locator("[data-needs-you-title]").evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  });
});

test.describe("the Decisions count leaves out bookkeeping (F6)", () => {
  test("a fresh workstream shows none, and its tooltip says the count is history", async ({ page }) => {
    await openApp(page, "runs=empty&wsManage=1");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    const decisions = pipHome(page).locator('[data-filter="decisions"]').first();
    await expect(decisions).toBeVisible();
    await expect(decisions.locator("[data-filter-count]")).toHaveText("0");
    await expect(decisions).toHaveAttribute("title", /in this timeline, decided or waiting\. What needs you now is in Needs you\./);
  });
});

test.describe("keys inside the open decision, the palette's Agents and Undo (F2, F8, F9, F13)", () => {
  const toast = (page: Page) => page.locator("[data-toast]");
  const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

  test("s skips the draft from inside its open decision, and the palette's Undo takes the toast down", async ({ page }) => {
    await openApp(page, "wsManage=1&runs=empty");
    await startWorkstream(page, "CA-401");
    await openPipHome(page);
    await workstreamRow(page, "CA-401").click();
    await expect(homeConversation(page)).toHaveText(/^Workstream: CA-401 /);
    await askPip(page, "Draft a comment");
    await homeSettled(page);
    await needOfKind(page, "draft").click();
    const pane = needsPane(page);
    await expect(pane).toBeVisible();
    // Focus is inside the pane, not on a row; the keys still act on the need it shows.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-needs-pane]"))).toBe(true);
    await page.keyboard.press("s");
    await expect(toast(page)).toContainText("Skipped the draft on CA-401.");

    // Undo from the palette: the offer's toast goes, the result is told.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette(page)).toBeVisible();
    await page.keyboard.type("undo");
    await palette(page).getByRole("option", { name: /Undo: Skipped the draft on CA-401/ }).click();
    await expect(toast(page)).toContainText("The draft is back.");
    await expect(toast(page).filter({ hasText: "Skipped the draft on CA-401." })).toHaveCount(0);
  });

  test("'agents' in the palette finds Open Agents first, and it opens the Agents screen", async ({ page }) => {
    await openApp(page);
    await openPipHome(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("agents");
    await expect(palette(page).getByRole("option").first()).toContainText("Open Agents");
    await page.keyboard.press("Enter");
    await expect(page.locator("main").getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  });

  test("a General run need's link says it opens the run", async ({ page }) => {
    const { pane } = await onPermission(page);
    await expect(pane.getByRole("link", { name: "Open the run" })).toBeVisible();
    await expect(pane.getByRole("link", { name: "Open in workstream" })).toHaveCount(0);
  });
});
