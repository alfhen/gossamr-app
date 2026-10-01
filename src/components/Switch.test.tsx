import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Switch, SwitchRow } from "./Switch";

const noop = vi.fn();

describe("Switch", () => {
  it("renders on", () => {
    const html = renderToStaticMarkup(<Switch checked onChange={noop} aria-label="x" />);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(html).not.toContain('disabled=""');
  });

  it("renders off", () => {
    expect(renderToStaticMarkup(<Switch checked={false} onChange={noop} aria-label="x" />)).toMatch(/role="switch"[^>]*aria-checked="false"/);
  });

  it("renders disabled", () => {
    expect(renderToStaticMarkup(<Switch checked onChange={noop} disabled aria-label="x" />)).toContain('disabled=""');
  });

  it("is busy, locked and shows a spinner while pending", () => {
    const html = renderToStaticMarkup(<Switch checked={false} onChange={noop} pending aria-label="x" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("data-spinner");
  });
});

describe("SwitchRow", () => {
  const html = renderToStaticMarkup(<SwitchRow label="Show done" description="Keeps finished items." checked onChange={noop} />);

  it("wraps the switch in the label so the whole row toggles", () => {
    expect(html.startsWith("<label")).toBe(true);
    expect(html).toContain("Show done");
    expect(html).toContain("Keeps finished items.");
  });

  it("names and describes the switch from the row text", () => {
    const labelId = /aria-labelledby="([^"]+)"/.exec(html)![1];
    const descId = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${labelId}"`);
    expect(html).toContain(`id="${descId}"`);
  });

  it("omits aria-describedby without a description", () => {
    expect(renderToStaticMarkup(<SwitchRow label="L" checked onChange={noop} />)).not.toContain("aria-describedby");
  });
});

describe("on/off preferences", () => {
  it.each(["../workspace/AgentsSwitch.tsx", "../workspace/PipPane.tsx", "../workspace/Settings.tsx"])("%s has no raw checkbox", (file) => {
    expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/type="checkbox"/);
  });
});
