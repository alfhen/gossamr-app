import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { ItemRef, Stray } from "../types";
import { useWorkspace } from "../workspaceStore";
import { escIsElsewhere } from "./escBack";
import { keyChooserOpen, useKeyChooser } from "./keyChooserStore";
import { useTabs } from "./tabsStore";
import { titlesOf } from "./useNeeds";
import { nounFor } from "./watchLogic";
import { StrayCard } from "./WatchNotices";
import { openWorkstreamTicket } from "./WorkstreamSheet";

const ref = (connectionId: string, key: string): ItemRef => ({ connectionId, externalId: key, key });

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  useTabs.getState().select(null);
  useKeyChooser.setState({ asking: null });
  await useWorkspace.getState().init(new MockBackend({ jira: 2, githubRepos: 6 }));
});

afterEach(() => vi.unstubAllGlobals());

describe("a workstream's Open KEY", () => {
  it("selects the ticket on the workstream's own site", () => {
    openWorkstreamTicket({ connectionId: "mock2", itemKey: "CA-402" });
    expect(useTabs.getState().selected).toBe("mock2:CA-402");
    openWorkstreamTicket({ connectionId: "mock", itemKey: "CA-402" });
    expect(useTabs.getState().selected).toBe("mock:CA-402");
  });
});

function buttonsOf(node: ReactNode, found: ReactElement<{ onClick?: () => void }>[] = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) return node.forEach((n) => buttonsOf(n, found)), found;
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (el.type === "button") found.push(el);
  buttonsOf(el.props?.children, found);
  return found;
}

describe("a stray ticket's key", () => {
  it("opens the ticket on the site the project is on", () => {
    const onOpen = vi.fn();
    const stray: Stray = { container: { connectionId: "mock2", externalId: "CA" }, containerName: "Customer App", keys: ["CA-402"] };
    const card = StrayCard({ stray, noun: nounFor("jira"), onOpen, onWatch: vi.fn(), onDismiss: vi.fn() });
    buttonsOf(card)[0].props.onClick?.();
    expect(onOpen).toHaveBeenCalledWith(ref("mock2", "CA-402"));
  });
});

describe("the title a need shows", () => {
  it("is each site's own title for a key both have", () => {
    const { items } = useWorkspace.getState();
    const titleOf = titlesOf(items, {});
    const acme = items["mock:CA-402"].title;
    const beta = items["mock2:CA-402"].title;
    expect(acme).not.toBe(beta);
    expect(titleOf(ref("mock", "CA-402"))).toBe(acme);
    expect(titleOf(ref("mock2", "CA-402"))).toBe(beta);
  });
});

describe("Escape with the key chooser open", () => {
  it("is left to the chooser", () => {
    const esc = { key: "Escape", defaultPrevented: false, target: null } as Parameters<typeof escIsElsewhere>[0];
    expect(escIsElsewhere(esc)).toBe(false);
    void useKeyChooser.getState().choose("CA-402", [ref("mock", "CA-402"), ref("mock2", "CA-402")]);
    expect(keyChooserOpen()).toBe(true);
    expect(escIsElsewhere(esc)).toBe(true);
    useKeyChooser.getState().answer(null);
    expect(keyChooserOpen()).toBe(false);
  });
});
