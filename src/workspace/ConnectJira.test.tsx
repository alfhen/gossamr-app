import { renderToStaticMarkup } from "react-dom/server";
import { isTauri } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { JiraBackend } from "../backend/jira";
import { auth } from "../backend/auth";
import { ConnectJiraView, sameAccount, signInApi, signInFrom, type ConnectJiraViewProps, type JiraFormValues, type SiteLookup } from "./ConnectJira";

const VALUES: JiraFormValues = { site: " acme.atlassian.net ", cloudId: "", email: " ann@acme.com ", token: " tok ", expiresOn: "2027-10-30" };
const IDLE: SiteLookup = { state: "idle" };

const view = (over: Partial<ConnectJiraViewProps> = {}) =>
  renderToStaticMarkup(
    <ConnectJiraView
      values={VALUES}
      lookup={IDLE}
      busy={false}
      error={null}
      scopesShown={false}
      copied={false}
      onChange={vi.fn()}
      onLookup={vi.fn()}
      onCreateToken={vi.fn()}
      onToggleScopes={vi.fn()}
      onCopyScopes={vi.fn()}
      onOpenPlainPage={vi.fn()}
      onSubmit={vi.fn()}
      {...over}
    />,
  );

describe("what the Connect Jira sheet sends", () => {
  it("trims every field and leaves out the cloud id until there is one", () => {
    expect(signInFrom(VALUES, IDLE)).toEqual({ site: "acme.atlassian.net", email: "ann@acme.com", token: "tok", expiresOn: "2027-10-30" });
  });

  it("sends the cloud id the site gave, or else the one typed", () => {
    expect(signInFrom({ ...VALUES, cloudId: "typed" }, { state: "found", cloudId: "found", site: "acme.atlassian.net" })?.cloudId).toBe("found");
    expect(signInFrom({ ...VALUES, cloudId: " typed " }, { state: "missing" })?.cloudId).toBe("typed");
  });

  it("ignores a cloud id that was found for another site than the one in the field", () => {
    const other: SiteLookup = { state: "found", cloudId: "acme-id", site: "acme.atlassian.net" };
    expect(signInFrom({ ...VALUES, site: "acme-eu" }, other)).toEqual({ site: "acme-eu", email: "ann@acme.com", token: "tok", expiresOn: "2027-10-30" });
    expect(signInFrom({ ...VALUES, site: "acme-eu", cloudId: "typed" }, other)?.cloudId).toBe("typed");
  });

  it("sends nothing while a field is empty", () => {
    for (const key of ["site", "email", "token", "expiresOn"] as const) expect(signInFrom({ ...VALUES, [key]: "  " }, IDLE)).toBeNull();
  });
});

describe("the Connect Jira sheet", () => {
  it("asks for the site, the token and its expiry, and offers to open Atlassian's token page", () => {
    const out = view();
    for (const text of ["Your Jira site", "Create token", "Your Atlassian email", "API token", "Token expires", "2027-10-30", "warns you 14 days before this date", "Connect Jira"]) expect(out).toContain(text);
    expect(out).toContain('type="password"');
    expect(out).not.toContain("Cloud id");
  });

  it("asks for the cloud id only when the site wouldn't give it", () => {
    expect(view({ lookup: { state: "missing" } })).toContain("Cloud id");
    expect(view({ lookup: { state: "found", cloudId: "c1", site: "acme.atlassian.net" } })).not.toContain("Cloud id");
  });

  it("says why a site couldn't be looked up instead of asking for a cloud id", () => {
    const out = view({ lookup: { state: "failed", message: "Gossamr couldn't reach acme.atlasian.net. Check the site." } });
    expect(out).toContain("couldn&#x27;t reach acme.atlasian.net");
    expect(out).toContain('role="alert"');
    expect(out).not.toContain("Cloud id");
  });

  it("lists the scopes to tick, with a way to copy them, when the page didn't fill in", () => {
    expect(view()).not.toContain("Copy scopes");
    const out = view({ scopesShown: true });
    expect(out).toContain("read:jira-work write:jira-work read:jira-user");
    expect(out).toContain("Copy scopes");
    expect(out).toContain("Open the plain page");
  });

  it("keeps Connect off until every field is filled, and while it is working", () => {
    const connect = (out: string) => /<button[^>]*type="submit"[^>]*>/.exec(out)?.[0] ?? "";
    expect(connect(view())).not.toContain("disabled");
    expect(connect(view({ values: { ...VALUES, token: "" } }))).toContain("disabled");
    expect(connect(view({ busy: true }))).toContain("disabled");
    expect(view({ busy: true })).toContain("Connecting…");
  });

  it("shows what went wrong as an alert, and a Cancel only when it can be cancelled", () => {
    expect(view({ error: "Jira didn't accept that email and token." })).toContain('role="alert"');
    expect(view()).not.toContain('role="alert"');
    expect(view()).not.toContain("Cancel");
    expect(view({ onCancel: vi.fn() })).toContain("Cancel");
  });
});

describe("whether a new token is for the account already signed in", () => {
  const status = (cloudId: string, accountId: string, name = "acme.atlassian.net") => ({
    site: { cloudId, name, url: `https://${name}` },
    me: { accountId, name: "Ann", avatarUrl: null },
    email: "ann@acme.com",
    expiresOn: "2027-10-30",
  });

  it("is the same when the site and the account are, whatever the address was typed as", () => {
    expect(sameAccount(status("c1", "u1"), status("c1", "u1", "acme.example.com"))).toBe(true);
  });

  it("is another when either differs, and when nobody was signed in", () => {
    expect(sameAccount(status("c1", "u1"), status("c2", "u1"))).toBe(false);
    expect(sameAccount(status("c1", "u1"), status("c1", "u2"))).toBe(false);
    expect(sameAccount(null, status("c1", "u1"))).toBe(false);
    expect(sameAccount({ site: null, me: null, email: null, expiresOn: null }, status("c1", "u1"))).toBe(false);
  });
});

vi.mock("@tauri-apps/api/core", async (orig) => ({ ...(await orig<object>()), isTauri: vi.fn(() => false) }));

describe("where the Connect Jira sheet signs in", () => {
  it("uses the workspace backend in a browser", () => {
    const mock = new MockBackend();
    expect(signInApi(mock)).toBe(mock);
  });

  it("sends the desktop's sample workspace to the real sign-in, so a token never reaches the mock", () => {
    vi.mocked(isTauri).mockReturnValue(true);
    try {
      expect(signInApi(new MockBackend())).toMatchObject({ jiraStatus: auth.status, jiraCloudId: auth.cloudId, jiraConnect: auth.connect });
      const real = new JiraBackend();
      expect(signInApi(real)).toBe(real);
    } finally {
      vi.mocked(isTauri).mockReturnValue(false);
    }
  });
});
