import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button, type ButtonVariant } from "./Button";
import { ButtonGroup } from "./ButtonGroup";
import { SearchField } from "./SearchField";
import { Segmented, chosenByKey, nextSegment } from "./Segmented";
import { Switch } from "./Switch";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Button", () => {
  it.each<[ButtonVariant, string]>([
    ["secondary", "ws-btn--secondary"],
    ["primary", "ws-btn--primary"],
    ["quiet", "ws-btn--quiet"],
    ["pip", "ws-btn--pip"],
    ["pipSolid", "ws-btn--pip-solid"],
    ["plain", "ws-btn--plain"],
    ["danger", "ws-btn--danger"],
  ])("draws the %s variant", (variant, cls) => {
    expect(html(<Button variant={variant}>Go</Button>)).toMatch(new RegExp(`<button type="button" class="ws-btn ${cls}">Go</button>`));
  });

  it("is a clear glass button of 28 px by default", () => {
    const out = html(<Button>Go</Button>);
    expect(out).toContain("ws-btn--secondary");
    expect(out).not.toMatch(/ws-btn--(sm|lg)/);
  });

  it("has three sizes", () => {
    expect(html(<Button size="sm">Go</Button>)).toContain("ws-btn--sm");
    expect(html(<Button size="lg">Go</Button>)).toContain("ws-btn--lg");
  });

  it("keeps the type, the aria attributes and the extra class it is given", () => {
    const out = html(
      <Button type="submit" aria-pressed disabled className="ml-auto">
        Go
      </Button>,
    );
    expect(out).toContain('type="submit"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('disabled=""');
    expect(out).toContain("ml-auto");
  });

  it("gives a plain button Pip's colour and a destructive one a red label", () => {
    expect(html(<Button variant="plain" pip>Ask Pip</Button>)).toContain("is-pip");
    expect(html(<Button destructive>Stop</Button>)).toContain("is-danger");
  });

  it("is a square for an icon alone", () => {
    expect(html(<Button iconOnly aria-label="Close">×</Button>)).toContain("ws-btn--icon");
  });
});

describe("ButtonGroup", () => {
  it("is one named capsule with a hairline between each pair", () => {
    const out = html(
      <ButtonGroup label="Steps">
        <Button>A</Button>
        <Button>B</Button>
        <Button>C</Button>
      </ButtonGroup>,
    );
    expect(out).toMatch(/^<div role="group" aria-label="Steps" class="ws-btn-group /);
    expect(out.match(/ws-btn-group-divider/g)).toHaveLength(2);
  });
});

describe("Segmented", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
    { value: "c", label: "Gamma" },
  ] as const;

  it("marks the chosen segment pressed and draws the lens", () => {
    const out = html(<Segmented label="Pick" value="b" onChange={vi.fn()} options={options} />);
    expect(out).toContain('role="group"');
    expect(out).toContain("ws-seg-thumb");
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-pressed="true"[^>]*>Beta</);
  });

  it("is a radio group in radio mode", () => {
    const out = html(<Segmented kind="radio" label="Pick" value="a" onChange={vi.fn()} options={options} />);
    expect(out).toContain('role="radiogroup"');
    expect(out.match(/role="radio"/g)).toHaveLength(3);
    expect(out).toMatch(/role="radio" aria-checked="true"[^>]*>Alpha</);
  });

  it("can be a toggle of one segment that is off", () => {
    const out = html(<Segmented label="Show" value={null} onChange={vi.fn()} options={[{ value: "mentions", label: "Mentions" }]} />);
    expect(out).toContain('aria-pressed="false"');
    expect(out).not.toContain("data-on");
  });

  it("carries the attributes given to a segment", () => {
    const out = html(<Segmented label="Show" value="a" onChange={vi.fn()} options={[{ value: "a", label: "A", title: "Tip", attrs: { "data-filter": "a" } }]} />);
    expect(out).toMatch(/title="Tip"[^>]*data-filter="a"/);
  });

  it("moves the selection with the arrow keys and wraps at the ends", () => {
    const values = ["a", "b", "c"] as const;
    expect(nextSegment(values, "a", "ArrowRight")).toBe("b");
    expect(nextSegment(values, "c", "ArrowRight")).toBe("a");
    expect(nextSegment(values, "a", "ArrowLeft")).toBe("c");
    expect(nextSegment(values, "b", "ArrowDown")).toBe("c");
    expect(nextSegment(values, "b", "ArrowUp")).toBe("a");
    expect(nextSegment(values, null, "ArrowRight")).toBe("a");
    expect(nextSegment(values, "b", "Enter")).toBeNull();
    expect(nextSegment([], null, "ArrowRight")).toBeNull();
  });

  it("chooses on the arrow key in radio mode, skips a disabled segment, and leaves toggles to their buttons", () => {
    expect(chosenByKey("radio", options, "a", "ArrowRight")).toBe("b");
    expect(chosenByKey("radio", [options[0], { ...options[1], disabled: true }, options[2]], "a", "ArrowRight")).toBe("c");
    expect(chosenByKey("pressed", options, "a", "ArrowRight")).toBeNull();
    expect(chosenByKey("radio", options, "a", "x")).toBeNull();
  });
});

describe("Switch", () => {
  const press = (checked: boolean, onChange: (on: boolean) => void) => {
    const el = Switch({ checked, onChange, "aria-label": "x" }) as unknown as { type: string; props: { onClick(): void } };
    el.props.onClick();
    return el;
  };

  it("is a native button, so Space and Enter press it", () => {
    const el = press(false, vi.fn());
    expect(el.type).toBe("button");
  });

  it("toggles to the other state when pressed", () => {
    const on = vi.fn();
    press(false, on);
    expect(on).toHaveBeenLastCalledWith(true);
    press(true, on);
    expect(on).toHaveBeenLastCalledWith(false);
  });

  it("draws a sunken track with a knob", () => {
    const out = html(<Switch checked onChange={vi.fn()} aria-label="x" />);
    expect(out).toContain("ws-switch");
    expect(out).toContain("ws-switch-knob");
  });
});

describe("SearchField", () => {
  it("is a glass capsule around a search input that keeps its label and placeholder", () => {
    const out = html(<SearchField value="ab" onChange={vi.fn()} aria-label="Search agents" placeholder="Search agents" />);
    expect(out).toMatch(/^<label class="ws-search /);
    expect(out).toMatch(/type="search"/);
    expect(out).toContain('aria-label="Search agents"');
    expect(out).toContain('value="ab"');
  });
});

describe("control styles", () => {
  const css = readFileSync(new URL("./controls.css", import.meta.url), "utf8");

  it("draws glass layers without a backdrop filter", () => {
    expect(css).not.toMatch(/backdrop-filter/);
  });

  it("stops the press swell, the thumb scale and the held knob under reduced motion", () => {
    const block = css.slice(css.indexOf("prefers-reduced-motion: reduce"));
    expect(block).toMatch(/\.ws-btn:active[^{]*\{\s*transform: none/);
    expect(block).toMatch(/data-pressing[^{]*\{\s*scale: 1;/);
    expect(block).toMatch(/\.ws-switch-knob\s*\{\s*width: 18px/);
  });

  it("turns a control inside a glass surface into a lens and goes solid for reduced transparency", () => {
    expect(css).toMatch(/\.ws-glass :is\([^)]*\.ws-btn--secondary/);
    expect(css).toContain("prefers-reduced-transparency");
    expect(css).toContain('data-transparency="reduce"');
  });
});
