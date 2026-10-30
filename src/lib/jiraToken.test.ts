import { describe, expect, it } from "vitest";
import { CREATE_TOKEN_URL, JIRA_SCOPES, defaultExpiry, isoDay } from "./jiraToken";

describe("the link that creates a Jira token", () => {
  it("is the address tested by hand, with the scopes as a URL-encoded JSON array", () => {
    expect(CREATE_TOKEN_URL).toBe(
      "https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken&expiryDays=max&appId=jira&selectedScopes=%5B%22read%3Ajira-work%22%2C%22write%3Ajira-work%22%2C%22read%3Ajira-user%22%5D",
    );
  });

  it("asks for the three scopes the client uses and no others", () => {
    const encoded = new URL(CREATE_TOKEN_URL).searchParams.get("selectedScopes");
    expect(JSON.parse(encoded ?? "")).toEqual([...JIRA_SCOPES]);
    expect(JIRA_SCOPES).toEqual(["read:jira-work", "write:jira-work", "read:jira-user"]);
  });
});

describe("the date a token is said to expire", () => {
  it("starts a year from today", () => {
    expect(defaultExpiry(new Date(2026, 9, 30, 23, 59))).toBe("2027-10-30");
    expect(defaultExpiry(new Date(2027, 11, 31, 0, 1))).toBe("2028-12-30");
  });

  it("is written in the local calendar with two-digit months and days", () => {
    expect(isoDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
