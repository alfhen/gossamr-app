import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { githubSnapshot, jiraSnapshot } from "../backend/mockProbes";
import type { ConnectionInfo } from "../types";
import { ConnectionsView, type ConnectionsViewProps } from "./Connections";
import { SignInBannerView } from "./SignInBanner";

const NOW = new Date("2026-10-30T12:00:00Z");
const CHECKED = "2026-10-30T11:57:00Z";
const gh: ConnectionInfo = { id: "github:ada", instanceId: "github", displayName: "GitHub", enabled: true, kind: "github", workspace: "ada", url: null, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false, reauth: false, status: githubSnapshot("ready", "ada", CHECKED), rechecking: false };
const jira: ConnectionInfo = { ...gh, id: "jira:c:u", instanceId: "jira", displayName: "Acme Jira", kind: "jira", workspace: "acme.atlassian.net", account: "Alf Henderson", status: jiraSnapshot("expiresSoon", CHECKED) };

const view = (over: Partial<ConnectionsViewProps> = {}) =>
  renderToStaticMarkup(
    <ConnectionsView
      connections={[jira, gh]}
      selectedId={gh.id}
      watch={[]}
      now={NOW}
      checking={false}
      confirming={null}
      busy={null}
      copied={false}
      toggling={[]}
      onSelect={vi.fn()}
      onCheck={vi.fn()}
      onSync={vi.fn()}
      onCopy={vi.fn()}
      onOpenTerminal={vi.fn()}
      onRename={vi.fn()}
      onManage={vi.fn()}
      onNewToken={vi.fn()}
      onAskRemove={vi.fn()}
      onCancel={vi.fn()}
      onRemove={vi.fn()}
      onToggle={vi.fn()}
      onConnectGithub={vi.fn()}
      {...over}
    />,
  );

describe("the connections list", () => {
  it("shows a switched-off connection as off in its detail, not its last probe", () => {
    const out = view({ connections: [{ ...jira, enabled: false }], selectedId: jira.id });
    expect(out).toContain("Off.");
    expect(out).not.toContain("Make a new token");
  });

  it("lists each connection with its status line and marks the selected one", () => {
    const out = view();
    expect(out).toContain("Acme Jira");
    expect(out).toContain("Token expires in 9 days");
    expect(out).toContain("Authenticated · ada");
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toContain("Checked 3m ago");
  });

  it("shows the detail of the selected connection only", () => {
    expect(view()).toContain('aria-label="GitHub details"');
    expect(view()).not.toContain('aria-label="Acme Jira details"');
    expect(view({ selectedId: jira.id })).toContain('aria-label="Acme Jira details"');
  });

  it("falls back to the first connection when the selected one is gone", () => {
    expect(view({ selectedId: "github:gone" })).toContain('aria-label="Acme Jira details"');
  });

  it("offers the command that fixes a connection, to copy and then check again", () => {
    const out = view({ connections: [{ ...gh, status: githubSnapshot("notSignedIn", "ada", CHECKED) }] });
    expect(out).toContain("gh auth login -h github.com");
    expect(out).toContain("Copy");
    expect(out).toContain("I&#x27;ve run it, check again");
    expect(out).toContain("Not signed in");
  });

  it("opens Terminal on the fix beside Copy, and offers neither when there is nothing to run", () => {
    const stuck = view({ connections: [{ ...gh, status: githubSnapshot("notSignedIn", "ada", CHECKED) }] });
    expect(stuck).toContain("Open Terminal");
    expect(stuck.indexOf("Copy")).toBeLessThan(stuck.indexOf("Open Terminal"));
    expect(view()).not.toContain("Open Terminal");
  });

  it("shows the name of a connection with a way to rename it, and none for the sample", () => {
    const out = view();
    expect(out).toContain("<h4");
    expect(out).toContain("Rename");
    expect(view({ connections: [{ ...gh, kind: "mock", displayName: "Sample data" }], selectedId: gh.id })).not.toContain("Rename");
  });

  it("offers a new token for a Jira token that is about to run out", () => {
    expect(view({ selectedId: jira.id })).toContain("Make a new token");
    expect(view({ selectedId: gh.id })).not.toContain("Make a new token");
  });

  it("says who drafts post as, and which account agents push as", () => {
    const out = view();
    expect(out).toContain("Drafts post as ada via GitHub.");
    expect(out).toContain("Agents clone and push with your own git and gh setup, which may be a different account.");
  });

  it("offers Remove in place of Disconnect and Sign out, and asks before it deletes", () => {
    for (const out of [view(), view({ selectedId: jira.id })]) {
      expect(out).toContain("Remove");
      expect(out).not.toContain("Disconnect");
      expect(out).not.toContain("Sign out");
      expect(out).not.toContain("alertdialog");
    }
    expect(view({ confirming: gh.id })).toContain("alertdialog");
    expect(view({ confirming: jira.id, selectedId: jira.id })).toContain("alertdialog");
  });

  it("says what Remove deletes for GitHub: the cache and the drafts, and that gh is untouched", () => {
    const out = view({ confirming: gh.id });
    expect(out).toContain("Remove GitHub? Gossamr deletes the pull requests and branches it cached for ada and closes the drafts that post as ada.");
    expect(out).toContain("Your gh login and GitHub stay as they are.");
  });

  it("says what Remove deletes for Jira, and not your conversations with Pip, which stay", () => {
    const out = view({ confirming: jira.id, selectedId: jira.id });
    expect(out).toContain("Remove Acme Jira? Gossamr deletes the tickets it cached, forgets your token and closes the drafts for it.");
    expect(out).toContain("Jira stays as it is.");
    expect(out).not.toContain("conversations with Pip");
  });

  it("shows the confirmation on the connection it was asked for, never on the one that takes its place", () => {
    const out = view({ connections: [jira], selectedId: jira.id, confirming: gh.id, busy: gh.id });
    expect(out).not.toContain("alertdialog");
    expect(out).not.toContain("Removing…");
  });

  it("disables Remove only for the connection being removed", () => {
    expect(view({ confirming: gh.id, busy: gh.id })).toContain("Removing…");
    expect(view({ confirming: gh.id, busy: "github:grace" })).not.toContain("Removing…");
  });

  it("gives each real connection a switch named for it, on or off as it is, and none to the sample", () => {
    const out = view({ connections: [{ ...jira, enabled: false }, gh, { ...gh, id: "mock", instanceId: "mock", kind: "mock", displayName: "Sample data" }] });
    expect(out.match(/role="switch"/g)).toHaveLength(2);
    expect(out).toMatch(/role="switch" aria-checked="false"[^>]*aria-label="Acme Jira"/);
    expect(out).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="GitHub"/);
  });

  it("gives no switch to a row that no instance backs, since turning it off would always fail", () => {
    const unbacked = { ...gh, id: "github:ada", instanceId: "github:ada" };
    expect(view({ connections: [unbacked] })).not.toContain('role="switch"');
  });

  it("keeps the switch beside the row's button, never inside it", () => {
    const row = view().match(/<li aria-label="GitHub connection".*?<\/li>/s)?.[0] ?? "";
    expect(row.indexOf("</button>")).toBeLessThan(row.indexOf('role="switch"'));
    expect(row.match(/<button/g)).toHaveLength(2);
  });

  it("shows Off on the row and in the detail, and stops Sync now, while a connection is off", () => {
    const off = { ...gh, enabled: false, status: githubSnapshot("off", "ada", CHECKED) };
    const out = view({ connections: [off] });
    expect(out).toContain("Off");
    expect(out).toContain("Gossamr doesn&#x27;t sync it and drafts for it wait.");
    expect(out).not.toContain("Authenticated");
    expect(out).toMatch(/disabled=""[^>]*>Sync now/);
  });

  it("holds only the switch that was pressed while its answer is on the way", () => {
    const out = view({ toggling: ["jira"] });
    expect(out.match(/aria-busy="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-busy="true"[^>]*aria-label="Acme Jira"/);
  });

  it("keeps only the selected row in the tab order, so the arrow keys move between rows", () => {
    const tabIndexes = [...view().matchAll(/data-connection="[^"]+"[^>]*tabindex="(-?\d)"/g)].map((m) => m[1]);
    expect(tabIndexes.sort()).toEqual(["-1", "0"]);
  });
});

describe("the banner for a connection that is signed out", () => {
  const noop = vi.fn();

  it("shows nothing while every connection is signed in", () => {
    expect(renderToStaticMarkup(<SignInBannerView lost={[]} onFix={noop} />)).toBe("");
  });

  it("offers Jira a new token", () => {
    const out = renderToStaticMarkup(<SignInBannerView lost={[jira]} onFix={noop} />);
    expect(out).toContain("Jira turned down your token");
    expect(out).toContain("Make a new token");
  });

  it("sends the others, and any several, to the connections", () => {
    expect(renderToStaticMarkup(<SignInBannerView lost={[gh]} onFix={noop} />)).toContain("GitHub is signed out");
    const many = renderToStaticMarkup(<SignInBannerView lost={[jira, gh]} onFix={noop} />);
    expect(many).toContain("2 connections are signed out");
    expect(many).toContain("Open connections");
  });
});

describe("the sign-in banner text", () => {
  it("says Jira isn't syncing, not that nothing is", () => {
    const out = renderToStaticMarkup(<SignInBannerView lost={[jira]} onFix={vi.fn()} />);
    expect(out).toContain("Jira isn&#x27;t syncing");
    expect(out).not.toContain("nothing is syncing");
  });
});
