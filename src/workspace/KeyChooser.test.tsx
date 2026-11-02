import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KeyChooserView } from "./KeyChooser";

describe("KeyChooserView", () => {
  const options = [
    { ref: { connectionId: "mock", externalId: "CA-402", key: "CA-402" }, site: "acme.atlassian.net", title: "Subject line variants" },
    { ref: { connectionId: "mock2", externalId: "CA-402", key: "CA-402" }, site: "beta.atlassian.net", title: null },
  ];
  const html = renderToStaticMarkup(<KeyChooserView keyName="CA-402" options={options} onPick={vi.fn()} />);

  it("asks which key it is and lists each site with an Open button", () => {
    expect(html).toContain("Which CA-402?");
    expect(html).toContain('aria-label="Open CA-402 on acme.atlassian.net"');
    expect(html).toContain('aria-label="Open CA-402 on beta.atlassian.net"');
  });

  it("shows a synced ticket's title and leaves a live one without", () => {
    expect(html).toContain("Subject line variants");
    expect(html.match(/text-ws-ink3/g)).toHaveLength(1);
  });
});
