import { expect, test, type Page } from "@playwright/test";
import { advanceRuns, githubWrites, mockRuns, peekSheet, peekTicket, pendingReviewDrafts, reviewDrafts, reviewedDraft, startAgent } from "./support/app";

/** Another Review of CA-402's build is started, as Pip does, and moved to done; its draft then waits in CA-402's peek. */
async function reviewAgain(page: Page) {
  await page.keyboard.press("Escape");
  const id = await startAgent(page, "CA-402", "reviewer", { repo: "acme/webshop", pr: 218 });
  await advanceRuns(page, 3, id);
  await expect.poll(async () => (await mockRuns(page)).find((r) => r.id === id)?.state).toBe("done");
  await peekTicket(page, "CA-402");
  return id;
}

test("one review of a pull request waits at a time, except one the person edited, and a posted one is never retired", async ({ page }) => {
  test.setTimeout(240_000);
  const first = await reviewedDraft(page);
  const [d1] = await pendingReviewDrafts(page);

  // The person edits the first review; saving it for the PR view posts nothing.
  await first.getByRole("textbox", { name: "Review summary" }).fill("Mine: the retry loop still needs a back-off.");
  await first.getByRole("button", { name: "Open PR view" }).click();
  const view = page.getByRole("dialog", { name: /^Pull request / });
  await expect(view).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect.poll(async () => (await reviewDrafts(page)).find((d) => d.id === d1.id)?.edited).toBe(true);

  // A newer review leaves the edited one standing beside it, and its card says so.
  const r2 = await reviewAgain(page);
  await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toHaveLength(2);
  const [d2] = await pendingReviewDrafts(page);
  expect(d2.runId).toBe(r2);
  expect((await reviewDrafts(page)).find((d) => d.id === d1.id)?.supersededBy).toBeNull();
  const second = peekSheet(page).locator(`article[data-draft="${d2.id}"]`);
  await expect(second.locator("[data-review-kept-older]")).toHaveText(/^An older review of #\d+ that you edited is still waiting; this one didn't replace it\.$/);

  // The person posts their edited one; the next review replaces the second and leaves the posted one as it is.
  await peekSheet(page).locator(`article[data-draft="${d1.id}"]`).getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
  const r3 = await reviewAgain(page);
  await expect.poll(async () => (await pendingReviewDrafts(page)).map((d) => d.runId)).toEqual([r3]);
  const [d3] = await pendingReviewDrafts(page);
  const all = await reviewDrafts(page);
  expect(all.find((d) => d.id === d2.id)).toMatchObject({ state: "retired", supersededBy: d3.id });
  expect(all.find((d) => d.id === d1.id)).toMatchObject({ state: "applied", supersededBy: null });
  expect(new Set(all.map((d) => d.pull)).size).toBe(1);
  expect(await githubWrites(page)).toHaveLength(1);
});
