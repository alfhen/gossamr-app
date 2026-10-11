import { expect, test, type Page } from "@playwright/test";
import { askPip, homeConversationRegion, mockRuns, openApp, openPip, peekSheet, pipIdle, pipPane, reviewedDraft } from "./support/app";

/** Pip's tool names, which the person should never read. */
const TOOL_NAME = /\b(get|list|propose|revise|retire|set)_[a-z_]+/;

const settled = (page: Page) => expect.poll(() => pipIdle(page), { message: "the sample Pip has no turn running or waiting" }).toBe(true);

const lastBubble = (page: Page) => pipPane(page).locator("[data-user-bubble]").last();

test("Discuss with Pip on a review draft shows a short line, and Pip names the draft and the run, never their ids or its tools", async ({ page }) => {
  const review = await reviewedDraft(page);
  const reviewRun = (await mockRuns(page)).find((r) => r.kind === "review" && r.key === "CA-402")!;
  expect(reviewRun).toBeTruthy();

  // The draft card names the run by ticket and step, and its link opens it.
  const from = review.locator("[data-provenance=run]");
  await expect(from).toContainText("From the CA-402 review");
  await expect(from).not.toContainText(/\b[0-9a-f]{8}\b/);
  // What gets posted to GitHub names the review by its ticket, not by the run's id, which a pull request's author can't use.
  const summary = await review.getByRole("textbox", { name: "Review summary" }).inputValue();
  expect(summary).toMatch(/\n\nDrafted by a Gossamr agent reviewing CA-402; posted only after a person approved it in Gossamr\.$/);
  expect(summary).not.toContain(reviewRun.id);
  if (reviewRun.shortId) expect(summary).not.toContain(reviewRun.shortId);
  expect(summary).not.toMatch(/agent run [0-9a-z-]{6,}/);

  await review.getByRole("button", { name: "Discuss with Pip" }).click();
  await expect(pipPane(page)).toBeVisible();
  await expect(lastBubble(page)).toHaveText("Discuss this review");
  await expect(pipPane(page)).toContainText("I read the review of acme/webshop#218 in full");
  await settled(page);

  const text = await pipPane(page).innerText();
  expect(text).not.toMatch(TOOL_NAME);
  expect(text).not.toMatch(/mock-\d+/);
  expect(text).not.toContain("mock-run-");
  expect(text).not.toContain(reviewRun.id);
  if (reviewRun.shortId) expect(text).not.toContain(reviewRun.shortId);
  expect(text).toContain("acme/webshop#218");

  // The stored turn keeps the short line: a reload shows it again, not the instruction Pip was given.
  await page.reload();
  // The sample backend starts over on a reload, so it asks what to watch again, and lands on Pip home; Pip's turns are kept.
  await page.getByRole("button", { name: "Start watching" }).click();
  const home = homeConversationRegion(page);
  await expect(home.locator("[data-user-bubble]").last()).toHaveText("Discuss this review");
  await expect(home).toContainText("I read the review of acme/webshop#218 in full");
  expect(await home.innerText()).not.toMatch(TOOL_NAME);
});

test("Discuss with Pip on an agent's comment draft shows a short line, never the instruction, its ids or Pip's tools", async ({ page }) => {
  await reviewedDraft(page);
  const reviewRun = (await mockRuns(page)).find((r) => r.kind === "review" && r.key === "CA-402")!;
  const comment = peekSheet(page).getByRole("article", { name: "Comment on CA-402" });
  await expect(comment).toHaveCount(1);
  const draftId = await comment.evaluate((el) => el.closest("[data-draft]")?.getAttribute("data-draft") ?? el.getAttribute("data-draft"));

  await comment.getByRole("button", { name: "Discuss with Pip" }).click();
  await expect(pipPane(page)).toBeVisible();
  await expect(lastBubble(page)).toHaveText("Discuss this draft");
  await settled(page);

  const text = await pipPane(page).innerText();
  expect(text).not.toMatch(TOOL_NAME);
  expect(text).not.toMatch(/mock-\d+/);
  expect(text).not.toContain(reviewRun.id);
  if (draftId) expect(text).not.toContain(draftId);
});

test("every ticket key in Pip's answer about the agents is a link, and one the cache doesn't hold opens a live peek", async ({ page }) => {
  await openApp(page);
  await openPip(page);
  await askPip(page, "What are my agents doing?");
  const answer = pipPane(page).locator("[data-pip-answer]").last();
  await expect(answer).toContainText("agent runs");
  await settled(page);

  const keys = await answer.evaluate((el) => {
    const out: { key: string; linked: boolean }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const m of (node.textContent ?? "").matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) out.push({ key: m[0], linked: !!node.parentElement?.closest("button") });
    }
    return out;
  });
  expect(keys.length).toBeGreaterThan(3);
  expect(keys.filter((k) => !k.linked)).toEqual([]);
  for (const key of ["CA-377", "DEVOPS-455"]) expect(keys.map((k) => k.key)).toContain(key);

  await answer.getByRole("button", { name: "DEVOPS-455" }).click();
  await expect(peekSheet(page)).toHaveAttribute("aria-label", "Details for DEVOPS-455");
  await expect(page.getByText("Couldn't find DEVOPS-455")).toHaveCount(0);
});
