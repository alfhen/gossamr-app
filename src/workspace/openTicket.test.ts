import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { ItemRef } from "../types";
import { useWorkspace } from "../workspaceStore";
import { knownTicketTitle, openTicket, openTicketByKey } from "./jump";
import { openPull } from "./openPull";
import { useKeyChooser } from "./keyChooserStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const ref = (connectionId: string, key: string): ItemRef => ({ connectionId, externalId: key, key });
const acme = ref("mock", "CA-402");
const beta = ref("mock2", "CA-402");
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  useToasts.setState({ toasts: [] });
  useTabs.getState().select(null);
  useKeyChooser.setState({ asking: null });
  await useWorkspace.getState().init(new MockBackend({ jira: 2, githubRepos: 6 }));
});

afterEach(() => vi.unstubAllGlobals());

describe("opening a ticket on two Jira sites", () => {
  it("asks which site when a typed key is cached on both", async () => {
    const opened = openTicketByKey("ca-402");
    await settle();
    expect(useKeyChooser.getState().asking?.options).toEqual([acme, beta]);
    useKeyChooser.getState().answer(beta);
    expect(await opened).toEqual(beta);
    expect(useTabs.getState().selected).toBe("mock2:CA-402");
  });

  it("opens nothing when the chooser is cancelled", async () => {
    const opened = openTicketByKey("CA-402");
    await settle();
    useKeyChooser.getState().answer(null);
    expect(await opened).toBeNull();
    expect(useTabs.getState().selected).toBeNull();
  });

  it("opens a key only one site has without asking", async () => {
    expect(await openTicketByKey("OPS-3")).toEqual(ref("mock2", "OPS-3"));
    expect(useKeyChooser.getState().asking).toBeNull();
    expect(useTabs.getState().selected).toBe("mock2:OPS-3");
  });

  it("opens the site a reference names without asking", async () => {
    expect(await openTicket(acme)).toBe(true);
    expect(useKeyChooser.getState().asking).toBeNull();
    expect(useTabs.getState().selected).toBe("mock:CA-402");
  });

  it("asks about a key cached on one site when the other site has its project", async () => {
    useWorkspace.setState((s) => ({ items: Object.fromEntries(Object.entries(s.items).filter(([k]) => k !== "mock2:CA-402")) }));
    expect(knownTicketTitle("CA-402")).toBe("");
    const opened = openTicketByKey("CA-402");
    await settle();
    expect(useKeyChooser.getState().asking?.options).toEqual([acme, beta]);
    useKeyChooser.getState().answer(null);
    await opened;
  });

  it("links a key both sites have without naming a title, and one site's key with its title", () => {
    expect(knownTicketTitle("CA-402")).toBe("");
    expect(knownTicketTitle("OPS-3")).toBe(useWorkspace.getState().items["mock2:OPS-3"].title);
  });
});

describe("opening a pull request whose ticket key two sites have", () => {
  const pull = { repo: "acme/webshop", number: 212 };

  it("asks which site's ticket, then opens that one", async () => {
    const opened = openPull(pull);
    await settle();
    expect(useKeyChooser.getState().asking?.options).toEqual([acme, beta]);
    useKeyChooser.getState().answer(beta);
    await opened;
    expect(useTabs.getState().selected).toBe("mock2:CA-402");
  });

  it("goes nowhere when the chooser is cancelled", async () => {
    const opened = openPull(pull);
    await settle();
    useKeyChooser.getState().answer(null);
    await opened;
    expect(useTabs.getState().selected).toBeNull();
  });
});
