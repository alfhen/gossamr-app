import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { githubSnapshot } from "../backend/mockProbes";
import { GithubRowView, type GithubRowViewProps } from "./Setup";

const CHECKED = "2026-10-30T11:57:00Z";

const view = (over: Partial<GithubRowViewProps> = {}) =>
  renderToStaticMarkup(<GithubRowView snapshot={githubSnapshot("ready", "ada", CHECKED)} checking={false} copied={false} problem={null} onCopy={vi.fn()} onOpenTerminal={vi.fn()} onCheck={vi.fn()} {...over} />);

describe("the first-run GitHub line", () => {
  it("says who gh is signed in as and offers no fix", () => {
    const out = view();
    expect(out).toContain("Authenticated · ada");
    expect(out).toContain("gh is signed in as ada on github.com");
    expect(out).not.toContain("<code");
    expect(out).not.toContain("check again");
  });

  it("shows the login command with Copy, Open Terminal and a check when gh has no login", () => {
    const out = view({ snapshot: githubSnapshot("notSignedIn", "ada", CHECKED) });
    expect(out).toContain("Not signed in");
    expect(out).toContain("gh auth login -h github.com");
    for (const label of ["Copy", "Open Terminal", "I&#x27;ve run it, check again"]) expect(out).toContain(label);
  });

  it("shows how to install gh when it is missing", () => {
    const out = view({ snapshot: githubSnapshot("notFound", "ada", CHECKED) });
    expect(out).toContain("Not found · gh");
    expect(out).toContain("brew install gh");
  });

  it("shows only that it is checking, with no old answer, while gh is asked", () => {
    const out = view({ checking: true, snapshot: null });
    expect(out).toContain("Checking…");
    expect(out).not.toContain("<code");
  });

  it("says Copied after the command was copied and shows a problem opening Terminal", () => {
    const out = view({ snapshot: githubSnapshot("notSignedIn", "ada", CHECKED), copied: true, problem: "Couldn't open Terminal: no" });
    expect(out).toContain("Copied");
    expect(out).toContain("Couldn&#x27;t open Terminal: no");
  });
});
