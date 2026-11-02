import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { claudeSnapshot, githubSnapshot, jiraSnapshot } from "../backend/mockProbes";
import type { ConnectionInfo } from "../types";
import { badgeText, ConnectionsView, type ConnectionsViewProps } from "./Connections";
import { addEntries } from "./connectionsLogic";
import { useJiraUi } from "./jiraUi";
import { SignInBannerView, fixSignIn } from "./SignInBanner";

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
      onRevealFolder={vi.fn()}
      onNewToken={vi.fn()}
      onAskRemove={vi.fn()}
      onCancel={vi.fn()}
      onRemove={vi.fn()}
      onToggle={vi.fn()}
      onConnectGithub={vi.fn()}
      addable={addEntries([])}
      onAdd={vi.fn()}
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

  it("falls back to the first connection shown when the selected one is gone", () => {
    expect(view({ selectedId: "github:gone" })).toContain('aria-label="GitHub details"');
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
    expect(out).toContain("gh&#x27;s active account is ada.");
    const other = { ...gh, status: { ...gh.status!, activeLogin: "alfhen" } };
    expect(view({ connections: [other, jira], selectedId: other.id })).toContain("gh&#x27;s active account is alfhen.");
  });

  it("gives the date a Jira token runs out in its detail while the list keeps the days", () => {
    const out = view({ selectedId: jira.id });
    expect(out).toContain("Your Jira token expires on 7 Nov. Make a new one and paste it here.");
    expect(out).toContain("Token expires in 9 days");
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

  it("labels the confirming button Yes, remove so only one button reads Remove", () => {
    const out = view({ confirming: gh.id });
    expect(out).toContain("Yes, remove");
    expect(out.match(/>Remove</g)).toHaveLength(1);
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

describe("a row's badge", () => {
  it("takes a Jira row's from the first two letters of its site, so two sites differ", () => {
    expect(badgeText(jira)).toBe("AC");
    expect(badgeText({ ...jira, workspace: "https://beta.atlassian.net" })).toBe("BE");
    expect(view()).toContain(">AC<");
  });

  it("keeps SD for the sample data and CL and CX for the providers", () => {
    expect(badgeText({ ...gh, kind: "mock", workspace: "Sample data" })).toBe("SD");
    expect(badgeText({ ...gh, kind: "provider", driver: "claude" })).toBe("CL");
    expect(badgeText({ ...gh, kind: "provider", driver: "codex" })).toBe("CX");
  });
});

describe("a provider in the list", () => {
  const claude: ConnectionInfo = { ...gh, id: "claude", instanceId: "claude", displayName: "Claude", kind: "provider", driver: "claude", workspace: "", account: "", status: null };

  it("is not offered Jira's Change account or GitHub's Sign in again", () => {
    const out = view({ connections: [jira, gh, claude], selectedId: "claude" });
    expect(out).toContain('aria-label="Claude details"');
    expect(out).not.toContain("Change account");
    expect(out).not.toContain("Sign in again");
    expect(view({ connections: [jira, gh, claude], selectedId: jira.id })).toContain("Change account");
  });

  it("has no Sync, Watching or Site sections, which belong to tickets and code", () => {
    const out = view({ connections: [jira, gh, claude], selectedId: "claude" });
    for (const word of ["Sync now", "Manage projects", "Manage repositories", ">Site<", ">Host<"]) expect(out).not.toContain(word);
    expect(view({ connections: [jira, gh, claude], selectedId: jira.id })).toContain("Sync now");
  });

  it("shows the sign-in command with Copy, Open Terminal and a check that says the command was run", () => {
    const out = view({ connections: [jira, gh, { ...claude, status: { ...claudeSnapshot("notSignedIn", CHECKED), fix: "claude auth login" } }], selectedId: "claude" });
    expect(out).toContain("claude auth login");
    expect(out).toContain("Copy");
    expect(out).toContain("Open Terminal");
    expect(out).toContain("I&#x27;ve run it, check again");
  });

  it("shows the account, the folder with Reveal in Finder, and what the provider is for, in that order", () => {
    const row = { ...claude, displayName: "Claude personal", configDir: "~/.claude-personal", status: claudeSnapshot("ready", CHECKED) };
    const all = view({ connections: [jira, gh, row], selectedId: "claude" });
    const out = all.slice(all.indexOf('aria-label="Claude personal details"'));
    const at = [">Status<", ">Name<", ">Account<", ">Remove<", ">Config folder<", ">~/.claude-personal<", "Reveal in Finder", "Pip and new agents run on Claude personal when you pick it. Agents already running keep going if you turn it off."].map((t) => out.indexOf(t));
    expect(at).not.toContain(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(out).not.toContain("Models</h4>");
  });

  it("says Codex is for new agents, and shows no Reveal in Finder for a usual setup", () => {
    const out = view({ connections: [jira, gh, { ...claude, id: "codex", instanceId: "codex", displayName: "Codex", driver: "codex", status: claudeSnapshot("ready", CHECKED) }], selectedId: "codex" });
    expect(out).toContain("New agents run on Codex when you pick it.");
    expect(out).toContain("Your usual setup");
    expect(out).not.toContain("Reveal in Finder");
  });

  it("names the shell variables a folder ignores", () => {
    const row = { ...claude, displayName: "Claude personal", configDir: "~/.claude-personal", status: { ...claudeSnapshot("ready", CHECKED), ignored: ["ANTHROPIC_API_KEY"] } };
    expect(view({ connections: [jira, gh, row], selectedId: "claude" })).toContain("Your shell sets ANTHROPIC_API_KEY. Claude personal doesn&#x27;t use it.");
  });

  it("says off in a provider's words, not a tracker's", () => {
    const out = view({ connections: [jira, gh, { ...claude, enabled: false, status: claudeSnapshot("off", CHECKED) }], selectedId: "claude" });
    expect(out).toContain("Off. Pip and new agents can&#x27;t use it.");
    expect(out).not.toContain("drafts for it wait");
  });

  it("asks before removing a provider and says its login and folder stay", () => {
    const out = view({ connections: [jira, gh, { ...claude, displayName: "Claude personal" }], selectedId: "claude", confirming: "claude" });
    expect(out).toContain("Remove Claude personal? Gossamr stops offering it.");
    expect(out).toContain("your login and folder stay as they are");
  });

  const accountOfDetail = (row: ConnectionInfo) => {
    const all = view({ connections: [jira, gh, row], selectedId: row.id });
    const from = all.indexOf(">Account<");
    return all.slice(from, all.indexOf(">Remove<", from));
  };

  it("keeps the login of a signed-in provider that is turned off, and does not say it is signed out", () => {
    const off = accountOfDetail({ ...claude, enabled: false, status: { ...claudeSnapshot("off", CHECKED), account: "alf@acme.com" } });
    expect(off).toContain("alf@acme.com");
    expect(off).not.toContain("Not signed in");
    expect(accountOfDetail({ ...claude, enabled: false, status: claudeSnapshot("ready", CHECKED) })).toContain("alf@acme.com");
  });

  it("keeps the login through a check that failed, and says not signed in only when the answer was signed out", () => {
    const failed = accountOfDetail({ ...claude, status: { ...claudeSnapshot("error", CHECKED), account: "alf@acme.com" } });
    expect(failed).toContain("alf@acme.com");
    expect(failed).not.toContain("Not signed in");
    expect(accountOfDetail({ ...claude, status: claudeSnapshot("notFound", CHECKED) })).not.toContain("Not signed in");
    expect(accountOfDetail({ ...claude, status: claudeSnapshot("notSignedIn", CHECKED) })).toContain("Not signed in");
  });

  it("says not checked yet in the account before the first answer", () => {
    expect(accountOfDetail(claude)).toContain("Not checked yet");
  });

  it("shows the sign-out command of a signed-in provider with Copy, built with its folder", () => {
    const row = { ...claude, displayName: "Claude work", configDir: "~/.claude-work", status: claudeSnapshot("ready", CHECKED) };
    const out = accountOfDetail(row);
    expect(out).toContain("CLAUDE_CONFIG_DIR=~/.claude-work claude auth logout");
    expect(out).toContain(">Copy<");
    expect(accountOfDetail({ ...row, id: "codex", instanceId: "codex", driver: "codex", configDir: "~/.codex-side" })).toContain("CODEX_HOME=~/.codex-side codex logout");
    expect(accountOfDetail({ ...row, status: claudeSnapshot("notSignedIn", CHECKED) })).not.toContain("logout");
    expect(accountOfDetail({ ...row, status: null })).not.toContain("logout");
  });

  it("says in the detail pane that a provider with no answer yet is not checked yet", () => {
    const out = view({ connections: [jira, gh, claude], selectedId: "claude" });
    expect(out).toContain("Not checked yet.");
  });
});

describe("the banner for a connection that is signed out", () => {
  const noop = vi.fn();

  it("never offers a provider the Jira token", () => {
    const claude: ConnectionInfo = { ...gh, id: "claude", instanceId: "claude", displayName: "Claude", kind: "provider" };
    const out = renderToStaticMarkup(<SignInBannerView lost={[claude]} onFix={noop} />);
    expect(out).toContain("Claude is signed out");
    expect(out).toContain("Open connections");
    expect(out).not.toContain("Make a new token");
  });

  it("shows nothing while every connection is signed in", () => {
    expect(renderToStaticMarkup(<SignInBannerView lost={[]} onFix={noop} />)).toBe("");
  });

  it("offers Jira a new token", () => {
    const out = renderToStaticMarkup(<SignInBannerView lost={[jira]} onFix={noop} />);
    expect(out).toContain("Jira turned down your token");
    expect(out).toContain("Make a new token");
  });

  it("opens the token sheet on the row that lost its sign-in", () => {
    fixSignIn(jira);
    expect(useJiraUi.getState()).toMatchObject({ connectOpen: true, connectInstanceId: "jira" });
    useJiraUi.getState().closeConnect();
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

describe("the + Add button and the groups", () => {
  it("groups the rows under Code and Tickets, with the group headings as plain text", () => {
    const out = view();
    expect(out.indexOf(">Code<")).toBeLessThan(out.indexOf("GitHub connection"));
    expect(out.indexOf("GitHub connection")).toBeLessThan(out.indexOf(">Tickets<"));
    expect(out.indexOf(">Tickets<")).toBeLessThan(out.indexOf("Acme Jira connection"));
    expect(out).not.toContain(">Models<");
  });

  it("shows a Models group when provider rows are shown", () => {
    const claude: ConnectionInfo = { ...gh, id: "claude", instanceId: "claude", displayName: "Claude", kind: "provider", driver: "claude" };
    expect(view({ connections: [jira, gh, claude] })).toContain(">Models<");
  });

  it("puts + Add beside Check all, secondary once a connection exists and primary before", () => {
    const withOne = view();
    expect(withOne).toMatch(/aria-haspopup="menu"[^>]*ws-btn--secondary[^>]*>\+ Add</);
    expect(withOne.indexOf("Check all")).toBeLessThan(withOne.indexOf("+ Add"));
    expect(view({ connections: [{ ...gh, kind: "mock" }] })).toMatch(/aria-haspopup="menu"[^>]*ws-btn--primary[^>]*>\+ Add</);
  });

  it("has no footer button for connecting GitHub", () => {
    const out = view();
    expect(out).not.toContain("Connect another GitHub account");
    expect(out).not.toContain("behind each ticket");
  });
});
