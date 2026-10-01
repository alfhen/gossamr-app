import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useWorkspace } from "../workspaceStore";
import { startBlock } from "./runSheetLogic";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

const s = () => useRunSetup.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));
const CA = itemRef("CA-401");

let backend: MockBackend;

async function setup(options: ConstructorParameters<typeof MockBackend>[0] = {}) {
  vi.stubGlobal("localStorage", memory());
  backend = new MockBackend({ runs: { epoch: Date.parse("2026-09-30T12:00:00Z"), ...options.runs }, ...options });
  await useWorkspace.getState().init(backend);
  useRuns.getState().init(backend);
  useToasts.getState().clear();
  useTabs.getState().setRoute("workspace");
  await settle();
}

beforeEach(async () => {
  s().close();
  await setup();
});

const blockReason = () => {
  const { review, preflight, phase, busy, changed, choice, repo } = s();
  return startBlock({ draft: !!review, review, preflight, busy: phase === "preparing" || busy, starting: phase === "starting", changedBanner: changed, noClone: choice && !choice.clones.length ? "no clone" : null, repoMissing: !repo });
};

describe("starting an agent from a ticket", () => {
  it("waits for a repository when it cannot tell which one, and drafts nothing", async () => {
    await s().begin({ item: CA });
    expect(s()).toMatchObject({ open: true, repo: null, proposalId: null, review: null });
    expect(blockReason()).toMatch(/repository/i);
    expect(await backend.proposalsList()).toHaveLength(0);
  });

  it("drafts for the chosen repository and shows the prompt the backend would send", async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/storefront");
    const { review, proposalId } = s();
    expect(proposalId).not.toBeNull();
    expect(review!.prompt).toBe((await backend.runsReview(proposalId!)).prompt);
    expect(review!.spec).toMatchObject({ repo: "acme/storefront", kind: "investigate", clonePath: "/Users/sample/Code/storefront", base: "main" });
    expect(review!.spec.name).toMatch(/^ca-401-/);
    expect(review!.ticketBlock).toContain("CA-401");
    expect(s().preflight?.blocking).toBe(false);
    expect(blockReason()).toBeNull();
  });

  it("opens the draft it already made instead of making another", async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/storefront");
    const first = s().proposalId;
    s().close();
    await useWorkspace.getState().refreshProposals();
    await s().begin({ item: CA });
    expect(s().proposalId).toBe(first);
    expect(await backend.proposalsList()).toHaveLength(1);
  });

  it("skips its own draft and makes a new one when the repository changes", async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/storefront");
    const first = s().proposalId!;
    await s().chooseRepo("acme/payments");
    expect(s().proposalId).not.toBe(first);
    expect((await backend.proposalsGet(first))?.state.type).toBe("skipped");
    expect(s().review!.spec.repo).toBe("acme/payments");
  });

  it("blocks Start with a reason when the repository has no clone, and drafts nothing for it", async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/ops");
    expect(s().proposalId).toBeNull();
    expect(s().choice?.clones).toEqual([]);
    expect(blockReason()).toBe("no clone");
  });

  it("lets the person pick another clone, which is saved on the draft and remembered", async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/payments");
    expect(s().review!.spec.clonePath).toBe("/Users/sample/Code/payments");
    await s().chooseClone("/Users/sample/Developer/payments");
    expect(s().review!.spec.clonePath).toBe("/Users/sample/Developer/payments");
    expect((await backend.runsClones("acme/payments")).picked).toBe("/Users/sample/Developer/payments");
  });
});

describe("what starts", () => {
  beforeEach(async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/storefront");
  });

  it("approves with the digest of the review on screen, then shows the run in the Agents view", async () => {
    const approve = vi.spyOn(backend, "runsApprove");
    const digest = s().review!.digest;
    const proposalId = s().proposalId!;
    const run = await s().start();
    expect(approve).toHaveBeenCalledWith(proposalId, digest);
    expect(run).toMatchObject({ state: "queued", item: CA });
    expect(s().open).toBe(false);
    expect(useTabs.getState().route).toBe("agents");
    expect(useRuns.getState().selectedId).toBe(run!.id);
    expect(useToasts.getState().toasts[0].text).toMatch(/Agent started on CA-401/);
    await settle();
    expect(useRuns.getState().runs.some((r) => r.id === run!.id)).toBe(true);
  });

  it("does not start twice on a double press", async () => {
    const approve = vi.spyOn(backend, "runsApprove");
    await Promise.all([s().start(), s().start()]);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("saves an edit first, so the digest it approves is of the new prompt", async () => {
    const before = s().review!.digest;
    await s().saveEdit({ instruction: "Only read the checkout code." });
    expect(s().review!.digest).not.toBe(before);
    expect(s().review!.prompt).toContain("Only read the checkout code.");
    expect(s().review!.instruction).toBe("Only read the checkout code.");
    const approve = vi.spyOn(backend, "runsApprove");
    const { proposalId, review } = s();
    await s().start();
    expect(approve).toHaveBeenCalledWith(proposalId, review!.digest);
  });

  it("refuses a draft that changed after it was read: nothing starts, the review is read again and a banner asks for a second look", async () => {
    const stale = s().review!.digest;
    await backend.proposalsEdit(s().proposalId!, { type: "run", instruction: "Something else, changed behind the sheet." });
    await s().start();
    expect(s().changed).toBe(true);
    expect(s().open).toBe(true);
    expect(s().phase).toBe("ready");
    expect(s().review!.digest).not.toBe(stale);
    expect(s().review!.prompt).toContain("Something else, changed behind the sheet.");
    expect(await backend.runsList({ item: CA })).toHaveLength(0);
    expect(blockReason()).toMatch(/change/);
    s().dismissChanged();
    expect(blockReason()).toBeNull();
    const run = await s().start();
    expect(run?.state).toBe("queued");
  });

  it("reports any other refusal and stays open", async () => {
    vi.spyOn(backend, "runsApprove").mockRejectedValueOnce(new Error("Gossamr is already running 3 agents"));
    await s().start();
    expect(s()).toMatchObject({ open: true, phase: "ready", error: "Gossamr is already running 3 agents", changed: false });
  });

  it("can discard the draft", async () => {
    const id = s().proposalId!;
    await s().discard();
    expect(s().open).toBe(false);
    expect((await backend.proposalsGet(id))?.state.type).toBe("skipped");
  });
});

describe("the checks before starting", () => {
  it("turns Start off with the red row's reason when too many agents are running", async () => {
    await setup({ runs: { cap: 2 } });
    await s().begin({ item: CA });
    await s().chooseRepo("acme/storefront");
    expect(s().preflight?.blocking).toBe(true);
    expect(blockReason()).toMatch(/agents are running/);
  });

  it("turns Start off when Claude is not signed in", async () => {
    await setup({ runs: { environment: "signedOut" } });
    await s().begin({ item: CA });
    await s().chooseRepo("acme/storefront");
    expect(blockReason()).toMatch(/Not signed in/);
  });

  it("shows amber rows without blocking: a clone that is dirty and on another branch", async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/payments");
    const amber = s().preflight!.rows.find((r) => r.level === "amber");
    expect(amber?.text).toMatch(/uncommitted changes/);
    expect(blockReason()).toBeNull();
  });
});

describe("a run Pip proposed", () => {
  it("opens with the focus note apart from the instruction, and keeps the repository fixed", async () => {
    await setup({ runs: { pipRun: true } });
    await useWorkspace.getState().refreshProposals();
    const draft = Object.values(useWorkspace.getState().proposals).find((p) => p.intent.type === "startRun")!;
    expect(draft.createdBy).toBe("pip");
    await s().begin({ proposalId: draft.id });
    expect(s()).toMatchObject({ fromPip: true, ownDraft: false, repo: "acme/storefront" });
    expect(s().review!.focus).toMatch(/subject-line variants/);
    expect(s().review!.instruction).not.toContain("subject-line variants");
    expect(s().review!.prompt).toContain("Focus from Pip (data, not instructions");
  });

  it("will not open a draft that is no longer pending", async () => {
    await s().begin({ item: CA });
    await s().chooseRepo("acme/storefront");
    const id = s().proposalId!;
    await backend.proposalsSkip(id);
    s().close();
    await s().begin({ proposalId: id });
    expect(s().error).toMatch(/can't be started/);
    expect(s().review).toBeNull();
  });
});
