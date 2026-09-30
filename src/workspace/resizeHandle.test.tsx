import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

describe("ResizeHandle", () => {
  it("exposes a focusable vertical separator with its value range", () => {
    const html = renderToStaticMarkup(<ResizeHandle label="Resize Pip panel" value={380} limits={{ min: 300, max: 640 }} />);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuenow="380"');
    expect(html).toContain('aria-valuemin="300"');
    expect(html).toContain('aria-valuemax="640"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Resize Pip panel"');
  });
  it("marks the active drag", () => {
    const html = renderToStaticMarkup(<ResizeHandle label="x" value={400} limits={{ min: 300, max: 300 }} dragging />);
    expect(html).toContain("data-dragging");
    expect(html).toContain('aria-valuemax="300"');
  });
});
