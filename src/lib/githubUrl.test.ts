import { describe, expect, it } from "vitest";
import { CLASSIC_TOKEN_URL, FINE_GRAINED_TOKEN_URL, parsePullRef, pullLabel, safeGithubUrl } from "./githubUrl";

describe("which addresses may be opened", () => {
  it("accepts https on github.com and on hosts that were configured", () => {
    expect(safeGithubUrl("https://github.com/acme/webshop/pull/1")).toBe("https://github.com/acme/webshop/pull/1");
    expect(safeGithubUrl(CLASSIC_TOKEN_URL)).not.toBeNull();
    expect(safeGithubUrl(FINE_GRAINED_TOKEN_URL)).not.toBeNull();
    expect(safeGithubUrl("https://git.example.com/a/b", ["git.example.com"])).not.toBeNull();
    expect(safeGithubUrl("https://GitHub.com/a")).not.toBeNull();
  });

  it("refuses other schemes, hosts, credentials and ports", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "http://github.com/a", "data:text/html,x", "https://github.com.evil.com/a", "https://evil.com/github.com", "https://user:pw@github.com/a", "https://github.com:8443/a", "//github.com/a", "github.com/a", "", "not a url", "https://git.example.com/a"]) {
      expect(safeGithubUrl(bad), bad).toBeNull();
    }
  });
});

describe("pull request references", () => {
  it("reads owner/repo#number and pull request pages", () => {
    expect(parsePullRef("acme/webshop#208")).toEqual({ repo: "acme/webshop", number: 208 });
    expect(parsePullRef(" https://github.com/acme/webshop/pull/208/files ")).toEqual({ repo: "acme/webshop", number: 208 });
    expect(parsePullRef("github.com/acme/web.shop/pull/7")).toEqual({ repo: "acme/web.shop", number: 7 });
    expect(pullLabel({ repo: "acme/webshop", number: 208 })).toBe("acme/webshop#208");
  });

  it("ignores everything else", () => {
    for (const no of ["webshop#208", "acme/webshop", "CA-208", "https://evil.com/acme/webshop/pull/1", "https://github.com/acme/webshop/issues/1", "acme/webshop#abc"]) expect(parsePullRef(no), no).toBeNull();
  });
});
