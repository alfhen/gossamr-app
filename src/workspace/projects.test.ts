import { describe, expect, it } from "vitest";
import type { WorkContainer } from "../types";
import { projectLabels } from "./projects";

const container = (connectionId: string, key: string, name: string) => ({ ref: { connectionId, externalId: key }, key, name }) as WorkContainer;
const site = (c: WorkContainer) => (c.ref.connectionId === "mock" ? "acme.atlassian.net" : "beta.atlassian.net");

describe("projectLabels", () => {
  const all = [container("mock", "CA", "Campaigns"), container("mock2", "CA", "Client campaigns"), container("mock2", "OPS", "Operations")];

  it("adds the site to projects whose key another site also has", () => {
    const label = projectLabels(all, site);
    expect(label(all[0])).toBe("Campaigns \u00b7 acme.atlassian.net");
    expect(label(all[1])).toBe("Client campaigns \u00b7 beta.atlassian.net");
  });

  it("leaves a project whose key is on one site alone", () => {
    expect(projectLabels(all, site)(all[2])).toBe("Operations");
  });

  it("adds nothing when no site is named, as with one Jira account", () => {
    expect(projectLabels(all, () => null)(all[0])).toBe("Campaigns");
  });
});
