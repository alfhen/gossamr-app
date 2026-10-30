import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConnectJiraView, signInFrom, type ConnectJiraViewProps, type JiraFormValues, type SiteLookup } from "./ConnectJira";
import { ReauthBannerView } from "./ReauthBanner";

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
    expect(signInFrom({ ...VALUES, cloudId: "typed" }, { state: "found", cloudId: "found" })?.cloudId).toBe("found");
    expect(signInFrom({ ...VALUES, cloudId: " typed " }, { state: "missing" })?.cloudId).toBe("typed");
  });

  it("sends nothing while a field is empty", () => {
    for (const key of ["site", "email", "token", "expiresOn"] as const) expect(signInFrom({ ...VALUES, [key]: "  " }, IDLE)).toBeNull();
  });
});

describe("the Connect Jira sheet", () => {
  it("asks for the site, the token and its expiry, and offers to open Atlassian's token page", () => {
    const out = view();
    for (const text of ["Your Jira site", "Create token", "Your Atlassian email", "API token", "Token expires", "2027-10-30", "It warns you 14 days before this date", "Connect Jira"]) expect(out).toContain(text);
    expect(out).toContain('type="password"');
    expect(out).not.toContain("Cloud id");
  });

  it("asks for the cloud id only when the site wouldn't give it", () => {
    expect(view({ lookup: { state: "missing" } })).toContain("Cloud id");
    expect(view({ lookup: { state: "found", cloudId: "c1" } })).not.toContain("Cloud id");
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

describe("the banner for a token Jira turned down", () => {
  it("shows only while a connection needs a new token, and offers one", () => {
    expect(renderToStaticMarkup(<ReauthBannerView dead={false} />)).toBe("");
    const out = renderToStaticMarkup(<ReauthBannerView dead />);
    expect(out).toContain("Jira turned down your token");
    expect(out).toContain("Make a new token");
  });
});
