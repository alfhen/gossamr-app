import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useWorkspace } from "../workspaceStore";
import { kindBlock } from "./runSheetLogic";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const s = () => useRunSetup.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));
const CA = itemRef("CA-402");
let backend: MockBackend;

beforeEach(async () => {
  s().close();
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  backend = new MockBackend({ githubRepos: 14, runs: { epoch: Date.parse("2026-09-30T12:00:00Z"), seed: "empty" } });
  await useWorkspace.getState().init(backend);
  useRuns.getState().init(backend);
  useToasts.getState().clear();
  useTabs.getState().setRoute("workspace");
  await backend.watchSetMode("github:ada", "everything");
  await settle();
});

describe("choosing the kind of work", () => {
  it("swaps the default instruction and the prompt, and back", async () => {
    await s().begin({ item: CA });
    expect(s().review!.prompt).toContain("Investigate this work");
    await s().chooseKind("triage");
    expect(s().kind).toBe("triage");
    expect(s().review!.spec.kind).toBe("triage");
    expect(s().review!.prompt).toContain("Triage this work");
    expect(s().review!.prompt).not.toContain("Investigate this work");
    await s().chooseKind("investigate");
    expect(s().review!.prompt).toContain("Investigate this work");
    expect((await backend.proposalsList()).filter((p) => p.state.type === "pending")).toHaveLength(1);
  });

  it("keeps the kind of a draft the sheet didn't make", async () => {
    const pip = await backend.runsDraft({ kind: "investigate", repo: "acme/webshop", clonePath: "/Users/sample/Code/webshop", base: "main", name: "ca-402-x-0a1b", instruction: "" }, CA);
    await s().begin({ item: CA, proposalId: pip.id });
    await s().chooseKind("build");
    expect(s().kind).toBe("investigate");
  });

  it("blocks Build without a ticket and drafts nothing", async () => {
    await s().begin({ kind: "build" });
    await s().chooseRepo("acme/webshop");
    expect(kindBlock(s().kind, s().item, s().pr)).toBe("Build needs a ticket");
    expect(s().proposalId).toBeNull();
    expect(await backend.proposalsList()).toHaveLength(0);
  });
});

describe("a build", () => {
  it("does not allow a push by default and says so in the prompt", async () => {
    await s().begin({ item: CA, kind: "build" });
    const { review, preflight } = s();
    expect(review!.spec.allowPush).toBe(false);
    expect(review!.prompt).toContain("do not push");
    expect(review!.prompt).not.toContain("You may push");
    expect(preflight!.rows.some((r) => r.level === "amber" && /may push/.test(r.text))).toBe(false);
  });

  it("puts the permission in the prompt and an amber row in the checks only when ticked, and takes it back", async () => {
    await s().begin({ item: CA, kind: "build" });
    const off = s().review!.digest;
    await s().saveEdit({ allowPush: true });
    expect(s().review!.prompt).toContain("You may push your branch and open a pull request.");
    expect(s().review!.digest).not.toBe(off);
    expect(s().preflight!.rows.find((r) => r.level === "amber" && /may push/.test(r.text))?.text).toContain("permission mode is auto");
    await s().saveEdit({ allowPush: false });
    expect(s().review!.prompt).not.toContain("You may push");
    expect(s().review!.digest).toBe(off);
  });

  it("leaves the permission behind when the kind changes", async () => {
    await s().begin({ item: CA, kind: "build" });
    await s().saveEdit({ allowPush: true });
    await s().chooseKind("verify");
    expect(s().review!.spec.allowPush).toBe(false);
    expect(s().review!.prompt).not.toMatch(/push/i);
  });
});

describe("a review", () => {
  it("drafts nothing until a pull request is chosen", async () => {
    await s().begin({ item: CA, kind: "review" });
    expect(s()).toMatchObject({ repo: "acme/webshop", proposalId: null, review: null });
    expect(await backend.proposalsList()).toHaveLength(0);
  });

  it("lists the pull requests that match, marking the ones that can't be reviewed", async () => {
    await s().begin({ item: CA, kind: "review" });
    await s().searchPrs("typo");
    const fork = s().prs.choices.find((c) => c.change.number === 215)!;
    expect(fork).toMatchObject({ selectable: false, note: "From a fork" });
    await s().searchPrs("CA-402");
    expect(s().prs.choices.find((c) => c.change.number === 212)).toMatchObject({ selectable: true });
    await s().searchPrs("banner");
    expect(s().prs.choices.find((c) => c.change.number === 190)).toMatchObject({ selectable: false, note: "Closed" });
    await s().searchPrs("   ");
    expect(s().prs).toMatchObject({ status: "idle", choices: [] });
  });

  it("drafts for the chosen pull request: its title, its commit and its name in the prompt", async () => {
    await s().begin({ item: CA, kind: "review" });
    await s().choosePr(212);
    const { review, preflight } = s();
    expect(review!.spec).toMatchObject({ kind: "review", pr: 212, prSha: "sha2120000" });
    expect(review!.prTitle).toBe("CA-402: Cache the category tree");
    expect(review!.prompt).toContain("Review pull request #212 in acme/webshop at commit sha2120000.");
    expect(preflight!.rows.some((r) => /Reviews pull request #212/.test(r.text))).toBe(true);
    expect(await s().start()).toMatchObject({ state: "queued", spec: { pr: 212 } });
  });

  it("opens straight on a pull request given by the Agent menu", async () => {
    await s().begin({ item: CA, kind: "review", pr: 212 });
    expect(s().review!.spec.pr).toBe(212);
  });

  it("opens in the repository the pull request is in, not the one used last", async () => {
    await s().begin({ item: CA, kind: "review", pr: 212, repo: "acme/gateway" });
    expect(s().repo).toBe("acme/gateway");
    s().close();
    await s().begin({ item: CA, kind: "review", pr: 212, repo: "ACME/Webshop" });
    expect(s().repo).toBe("acme/webshop");
  });

  it("refuses a pull request from a fork, with the reason, and drafts nothing", async () => {
    await s().begin({ item: CA, kind: "review" });
    await s().choosePr(215);
    expect(s().error).toMatch(/comes from a fork/);
    expect(s().review).toBeNull();
    expect((await backend.proposalsList()).filter((p) => p.state.type === "pending")).toHaveLength(0);
  });

  it("forgets the pull request when the kind changes", async () => {
    await s().begin({ item: CA, kind: "review", pr: 212 });
    await s().chooseKind("verify");
    expect(s().pr).toBeNull();
    expect(s().review!.spec.pr).toBeNull();
  });
});
