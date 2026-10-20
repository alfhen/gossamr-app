import { expect, test, type Page } from "@playwright/test";
import { expectVisibleFocus, githubWrites, peekSheet, pipPane, reviewedDraft } from "./support/app";

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
