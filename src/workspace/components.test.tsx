import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChipRow } from "./FilterBar";
import { PaletteView } from "./Palette";
import { TabStrip } from "./TabBar";
import type { Command } from "./commands";
import type { Tab } from "./tabsStore";

const command = (id: string, label: string): Command => ({ id, group: "App", label, run: vi.fn() });
const palette = (results: Command[], active = 0, query = "") =>
  renderToStaticMarkup(<PaletteView query={query} results={results} active={active} onQuery={vi.fn()} onActive={vi.fn()} onRun={vi.fn()} onClose={vi.fn()} />);

describe("PaletteView", () => {
  it("is a modal dialog with a combobox that points at the active option", () => {
    const out = palette([command("a", "Open settings"), command("b", "New tab")], 1);
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-activedescendant="palette-b"');
    expect(out).toMatch(/id="palette-b"[^>]*aria-selected="true"/);
    expect(out).toMatch(/id="palette-a"[^>]*aria-selected="false"/);
  });

  it("puts a heading where the group changes, with an icon and hint on each entry", () => {
    const c = (id: string, group: Command["group"], label: string, extra: Partial<Command> = {}): Command => ({ id, group, label, run: vi.fn(), ...extra });
    const out = palette([c("a", "Projects", "DevOps", { icon: "◧", hint: "current" }), c("b", "Projects", "Webshop"), c("c", "Go to", "Open drafts", { hint: "3 pending" })]);
    expect(out.match(/role="presentation"/g)).toHaveLength(2);
    expect(out.indexOf("Projects")).toBeLessThan(out.indexOf("DevOps"));
    expect(out.indexOf("Go to")).toBeGreaterThan(out.indexOf("Webshop"));
    expect(out).toContain("◧");
    expect(out).toContain("3 pending");
  });

  it("lists its key hints in the footer, and says what a prompt step expects", () => {
    const out = palette([command("a", "x")]);
    for (const hint of ["move", "select", "close"]) expect(out).toContain(hint);
    const back = renderToStaticMarkup(
      <PaletteView query="" results={[]} active={0} placeholder="Title" empty="Type a title" hints={["↵ select", "esc back"]} onQuery={vi.fn()} onActive={vi.fn()} onRun={vi.fn()} onClose={vi.fn()} />,
    );
    expect(back).toContain('placeholder="Title"');
    expect(back).toContain("Type a title");
    expect(back).toContain("back");
    expect(back).not.toContain("Nothing matches");
  });

  it("says so when nothing matches", () => {
    const out = palette([], 0, "zzz");
    expect(out).toContain("Nothing matches");
    expect(out).not.toContain("aria-activedescendant");
  });
});

describe("ChipRow", () => {
  it("gives each chip a labelled remove button", () => {
    const out = renderToStaticMarkup(<ChipRow chips={[{ label: "Blocked" }, { label: "Assigned to me" }]} onRemove={vi.fn()} />);
    expect(out).toContain('aria-label="Remove filter Blocked"');
    expect(out).toContain('aria-label="Remove filter Assigned to me"');
  });
});

describe("TabStrip", () => {
  const tab = (id: string): Tab => ({ id, title: id, filter: { type: "and", filters: [] }, view: "list" });

  it("marks the active tab and makes only it a tab stop", () => {
    const out = renderToStaticMarkup(
      <TabStrip tabs={[tab("one"), tab("two")]} activeId="two" labelOf={(t) => t.title!} onActivate={vi.fn()} onClose={vi.fn()} onNew={vi.fn()} />,
    );
    expect(out).toContain('role="tablist"');
    expect(out).toMatch(/id="tab-two"[^>]*aria-selected="true"/);
    expect(out).toMatch(/id="tab-one"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    expect(out).toContain('aria-label="Close tab one"');
  });
});
