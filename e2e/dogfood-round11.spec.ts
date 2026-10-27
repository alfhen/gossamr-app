import { expect, test } from "@playwright/test";
import { githubWrites, jiraWrites, needRow, needsPane, openAgents, openApp, openJiraSent, peekSheet, pipCommentDraft, pipPane, reviewedDraft, selectWorkstream, startWorkstream, openNeedRow } from "./support/app";

// Fixes from the eleventh dogfood round: the pause before a GitHub review with @everyone or a secret (G1), What Jira saw from
// me saying GitHub reviews are not listed (G2), and the chip "Post" on a review draft (G6).

test.describe("a GitHub review with risky words (G1)", () => {
  test("pauses on @everyone in the summary, posts nothing until Post it anyway, and Esc keeps the edit", async ({ page }) => {
    test.setTimeout(90_000);
    const review = await reviewedDraft(page);
    const summary = review.locator("[data-review-summary]");
    await summary.fill(`${await summary.inputValue()} cc @everyone`);
    await review.getByRole("button", { name: "Approve" }).click();
    const pause = review.locator("[data-post-pause]");
    await expect(pause).toContainText("Your edit mentions everyone at “@everyone” (line 6). Everyone on the pull request would see it once it is posted.");
    await expect(pause.getByRole("button", { name: "Keep editing" })).toBeFocused();
    expect(await githubWrites(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(pause).toHaveCount(0);
    await expect(summary).toHaveValue(/cc @everyone/);
    expect(await githubWrites(page)).toEqual([]);
    await review.getByRole("button", { name: "Approve" }).click();
    await expect(pause).toBeVisible();
    await review.getByRole("button", { name: "Post it anyway" }).click();
    await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
    expect((await githubWrites(page))[0].body).toContain("cc @everyone");
  });

  test("pauses on a secret in an inline comment, masked in the note", async ({ page }) => {
    test.setTimeout(90_000);
    const review = await reviewedDraft(page);
    const comment = review.getByRole("textbox", { name: /^Comment on src\/consumer\/retry\.ts:42/ });
    await comment.fill(`${await comment.inputValue()} password: hunter22x`);
    await review.getByRole("button", { name: "Approve" }).click();
    const pause = review.locator("[data-post-pause]");
    await expect(pause).toContainText("like a password, key or token at “hu…”");
    await expect(pause).not.toContainText("hunter22x");
    expect(await githubWrites(page)).toEqual([]);
    await pause.getByRole("button", { name: "Keep editing" }).click();
    await expect(pause).toHaveCount(0);
    expect(await githubWrites(page)).toEqual([]);
  });

  test("does not pause a review with no risky words", async ({ page }) => {
    test.setTimeout(90_000);
    const review = await reviewedDraft(page);
    const summary = review.locator("[data-review-summary]");
    await summary.fill(`${await summary.inputValue()} Thanks, @mette.`);
    await review.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => (await githubWrites(page)).length).toBe(1);
    await expect(peekSheet(page).locator("[data-post-pause]")).toHaveCount(0);
  });
});

test.describe("What Jira saw from me and GitHub reviews (G2)", () => {
  test("says the GitHub reviews are not listed and where they show", async ({ page }) => {
    await openApp(page, "runs=empty");
    await openJiraSent(page);
    const sent = page.locator("[data-jira-sent]");
    await expect(sent.getByRole("heading", { name: "What Jira saw from me" })).toBeVisible();
    await expect(sent).toContainText("GitHub reviews Gossamr posted are not listed here; each shows in its workstream's timeline as “You posted an agent's GitHub review”.");
    await expect(sent).toContainText("No posts to Jira from Gossamr are on record here.");
  });
});

test.describe("the chip on a GitHub review draft (G6)", () => {
  test("reads Post, not Approve, while its group stays Approve", async ({ page }) => {
    test.setTimeout(90_000);
    await reviewedDraft(page);
    await peekSheet(page).getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
    await openAgents(page);
    await openNeedRow(page, "GitHub review");
    const row = needRow(page, "GitHub review");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-group", "approve");
    await expect(row.locator("[data-needs-you-chip]")).toHaveText("Post");
  });
});


// Keyboard and screen-reader fixes (G5, G7 to G14).

test.describe("Pause and Resume keep the keyboard (G9), Close… is asked as a group (G13)", () => {
  test("Pause lands on Resume, Resume on Pause, and Tab stays between Close workstream and Keep", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(controls.getByRole("button", { name: "Resume" })).toBeFocused();
    await controls.getByRole("button", { name: "Resume" }).click();
    await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeFocused();
    await controls.getByRole("button", { name: "Close…" }).click();
    const ask = controls.getByRole("group", { name: "Close this workstream" });
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
    await expect(ask).toHaveAttribute("aria-describedby", /\S+ \S+/);
    await page.keyboard.press("Tab");
    await expect(ask.getByRole("button", { name: "Close workstream" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(ask.getByRole("button", { name: "Keep" })).toBeFocused();
  });

  test("the paused banner is not a live region that holds buttons (G10)", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "runs=empty");
    await startWorkstream(page, "CA-401");
    await openAgents(page);
    await selectWorkstream(page, "CA-401");
    const controls = pipPane(page).locator("[data-workstream-controls]");
    await controls.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(controls.locator("[data-paused-banner]")).toHaveAttribute("role", "group");
    expect(await page.locator('[role="status"]:not([data-toast-host])').evaluateAll((els) => els.filter((el) => el.querySelector("button")).map((el) => el.outerHTML.slice(0, 160)))).toEqual([]);
  });
});

test.describe("Esc at the posting pause (G14)", () => {
  test("closes the editor and the warning together and keeps the words", async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, "runs=empty");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "All projects" }).click();
    await startWorkstream(page, "CA-408");
    await openAgents(page);
    await selectWorkstream(page, "CA-408");
    const draft = await pipCommentDraft(page, "CA-408");
    await draft.getByRole("button", { name: "Edit" }).click();
    const field = needsPane(page).locator("textarea").first();
    await field.fill(`${await field.inputValue()}\n\ncc @everyone\nPassword: hunter2`);
    await draft.getByRole("button", { name: "Approve" }).click();
    await expect(draft.locator("[data-post-pause]")).toBeVisible();
    await field.focus();
    await page.keyboard.press("Escape");
    await expect(draft.locator("[data-post-pause]")).toHaveCount(0);
    await expect(draft.getByRole("button", { name: "Edit" })).toBeFocused();
    await expect(draft).toContainText("Password: hunter2");
    expect(await jiraWrites(page)).toEqual([]);
  });
});

