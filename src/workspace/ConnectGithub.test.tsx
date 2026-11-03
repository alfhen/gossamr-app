import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConnectFrame, ConnectGithubView } from "./ConnectGithub";

describe("the GitHub sheet", () => {
  it("is titled Add GitHub account, to match + Add", () => {
    const out = renderToStaticMarkup(
      <ConnectGithubView found={null} connected={[]} signedOut={[]} connecting={null} error={null} copied={false} onConnect={vi.fn()} onCopy={vi.fn()} onOpenTerminal={vi.fn()} onCheck={vi.fn()} onClose={vi.fn()} />,
    );
    expect(out).toContain("Add GitHub account</h2>");
    expect(out).not.toContain("Connect GitHub");
  });

  it("names its dialog Add GitHub account unless given another label", () => {
    expect(renderToStaticMarkup(<ConnectFrame onClose={vi.fn()}>x</ConnectFrame>)).toContain('aria-label="Add GitHub account"');
  });
});
