import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { githubSnapshot, jiraSnapshot } from "../backend/mockProbes";
import type { ConnectionInfo } from "../types";
import { ConnectionsView, type ConnectionsViewProps } from "./Connections";
import { SignInBannerView } from "./SignInBanner";

const NOW = new Date("2026-10-30T12:00:00Z");
const CHECKED = "2026-10-30T11:57:00Z";
const gh: ConnectionInfo = { id: "github:ada", instanceId: "github", displayName: "GitHub", enabled: true, kind: "github", workspace: "ada", url: null, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false, reauth: false, status: githubSnapshot("ready", "ada", CHECKED) };
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
      onConnectGithub={vi.fn()}
      {...over}
    />,
  );

describe("the connections list", () => {
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
    expect(out).toContain("Agents clone and push as whichever account gh has active.");
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

  it("says what Remove deletes for GitHub: the cache, the token and the drafts, and that gh is untouched", () => {
    const out = view({ confirming: gh.id });
    expect(out).toContain("Remove GitHub? Gossamr deletes the pull requests and branches it cached for ada, forgets its token and closes the drafts that post as ada.");
    expect(out).toContain("Your gh login and GitHub stay as they are.");
  });

  it("says what Remove deletes for Jira, including your conversations with Pip", () => {
    const out = view({ confirming: jira.id, selectedId: jira.id });
    expect(out).toContain("Remove Acme Jira? Gossamr deletes the tickets it cached and your conversations with Pip, forgets your token and closes the drafts for it.");
    expect(out).toContain("Jira stays as it is.");
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
