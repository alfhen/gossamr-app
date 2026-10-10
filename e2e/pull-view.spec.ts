import { expect, test, type Page } from "@playwright/test";
import {
  agentsSettled,
  expectVisibleFocus,
  finishOnHome,
  githubWrites,
  homeComposer,
  homeConversationRegion,
  homeRunCards,
  homeSettled,
  inlineStart,
  mockRuns,
  openApp,
  openPipHome,
  peekSheet,
  pipHome,
  pipPane,
  reviewedDraft,
  setBudget,
  startWorkstream,
  stepChip,
  surfacePullRequests,
  workstreamEvents,
  workstreamRow,
} from "./support/app";

const RETRY = "src/consumer/retry.ts";

/** What has the keyboard, by the attribute j and k step through: a file's path or a comment's place. */
const focusedNav = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.closest("[data-pull-file]")?.getAttribute("data-pull-file") && el.hasAttribute("data-pull-comment") ? `comment ${el.getAttribute("data-pull-comment")}` : el?.matches("h3[data-pull-nav]") ? `file ${el.closest("[data-pull-file]")?.getAttribute("data-pull-file")}` : (el?.tagName ?? "nothing");
  });

/** Steps through the view with j and k, with a visible focus ring at each stop. */
async function walk(page: Page, keys: string[], expected: string[]) {
  for (const [i, key] of keys.entries()) {
    await page.keyboard.press(key);
    await expect.poll(() => focusedNav(page)).toBe(expected[i]);
    await expectVisibleFocus(page);
  }
}

test("from the peek's development section: the pull request in Gossamr with the pending review's comments, j and k through it, Esc back", async ({ page }) => {
  await reviewedDraft(page);
  const row = peekSheet(page).getByRole("list", { name: "Linked code" }).getByRole("button", { name: /^CA-402: Cache the category tree \(agent\)/ });
  await row.click();
  const open = peekSheet(page).getByRole("button", { name: "View in Gossamr" });
  await open.click();
  const view = page.getByRole("dialog", { name: "Pull request acme/webshop#218" });
  await expect(view).toBeVisible();
  await expect(view.getByRole("note", { name: `Comment on ${RETRY}:42` })).toBeVisible();

  await walk(page, ["j", "j", "j", "j", "j", "k", "k"], [`file ${RETRY}`, `comment ${RETRY}:17`, `comment ${RETRY}:42`, "file src/consumer/index.ts", "file src/consumer/index.ts", `comment ${RETRY}:42`, `comment ${RETRY}:17`]);
  // Tab stays in the view.
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Pull request acme/webshop#218"]'))).toBe(true);

  // The app's shortcuts with a modifier don't reach behind the view: ⌘J doesn't open Pip under it, and the keyboard stays.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(pipPane(page)).toHaveCount(0);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Pull request acme/webshop#218"]'))).toBe(true);

  // Esc closes the view only: the peek stays, and the keyboard is back on the button that opened it.
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(peekSheet(page)).toBeVisible();
  await expect(open).toBeFocused();
  expect(await githubWrites(page)).toEqual([]);
});

test("from the step rail's Review step on Pip home, the view opens with the review's draft; j typed in the composer stays text", async ({ page }) => {
  test.setTimeout(120_000);
  // GitHub is signed in and the agents' repository watched, as the real app needs before it reads the build's pull request.
  await openApp(page, "runs=empty&prSurface=manual&wsManage=1&mockRepos=12");
  await agentsSettled(page);
  await startWorkstream(page, "CA-401");
  const ws = (await workstreamEvents(page))[0].workstreamId;
  await setBudget(page, ws, { autoTurns: 12 });
  await openPipHome(page);
  await workstreamRow(page, "CA-401").click();

  // Intake to a finished review, as the journey goes: investigate in place, then the rules, with the plan approved in the peek.
  await homeConversationRegion(page).getByRole("button", { name: "Investigate CA-401", exact: true }).click();
  await homeSettled(page);
  const start = await inlineStart(page, homeRunCards(page, "CA-401").last());
  await start.getByRole("button", { name: "Start agent" }).click();
  await expect(start).toHaveCount(0);
  const newest = async (kind: string) => (await mockRuns(page)).find((r) => r.kind === kind) ?? null;
  const started = async (kind: string) => {
    await expect.poll(async () => (await newest(kind))?.id ?? null).not.toBeNull();
    return (await newest(kind))!;
  };
  await finishOnHome(page, (await started("investigate")).id);
  await finishOnHome(page, (await started("triage")).id);
  await finishOnHome(page, (await started("plan")).id);
  const planChip = stepChip(page, "plan").locator("[data-step-chip]");
  if ((await planChip.getAttribute("aria-expanded")) !== "true") await planChip.click();
  await stepChip(page, "plan").getByRole("article", { name: "Update the description of CA-401" }).getByRole("button", { name: "Review on CA-401 →" }).click();
  await peekSheet(page).getByRole("article", { name: "Update the description of CA-401" }).getByRole("button", { name: "Update description" }).click();
  await page.keyboard.press("Escape");
  await expect(peekSheet(page)).toHaveCount(0);
  await finishOnHome(page, (await started("build")).id);
  await surfacePullRequests(page);
  await finishOnHome(page, (await started("review")).id);

  const open = stepChip(page, "review").getByRole("button", { name: /^PR view of acme\/storefront#\d+$/ });
  await expect(open).toBeVisible();
  const name = (await open.getAttribute("aria-label"))!.replace(/^PR view of /, "");
  await open.click();
  const view = page.getByRole("dialog", { name: `Pull request ${name}` });
  await expect(view).toBeVisible();
  // The pending review draft's comments are there, at their lines.
  await expect(view.locator("[data-pull-review]")).toContainText("not posted");
  await expect(view.getByRole("note", { name: `Comment on ${RETRY}:42` })).toBeVisible();
  await walk(page, ["j", "j", "k"], [`file ${RETRY}`, `comment ${RETRY}:17`, `file ${RETRY}`]);
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(pipHome(page)).toBeVisible();
  // The repository is watched and the token may write there, so the review's draft offers posting, not just the view.
  const draft = pipHome(page).getByRole("article", { name: `GitHub review of ${name}` }).first();
  await expect(draft.getByRole("button", { name: "Review and post →" })).toBeVisible();

  // With the view closed, j and k typed in the composer are just text.
  await homeComposer(page).click();
  await page.keyboard.type("jk");
  await expect(homeComposer(page)).toHaveValue("jk");
  await expect(view).toHaveCount(0);
  expect(await githubWrites(page)).toEqual([]);
});
