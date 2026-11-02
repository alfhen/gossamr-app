import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PickerInstance } from "../lib/modelPicker";
import type { ModelOption } from "../types";
import { ModelMenu, ModelPicker } from "./ModelPicker";

const noop = vi.fn();
const add = { open: false, id: "", busy: false, problem: null, field: "f", onStart: noop, onId: noop, onSubmit: noop };

const work: PickerInstance = { id: "claude_work", name: "Claude work", driver: "claude", unavailable: null };
const personal: PickerInstance = { id: "claude", name: "Claude personal", driver: "claude", unavailable: "Not signed in" };
const models: Record<string, ModelOption[]> = {
  claude_work: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
  ],
  claude: [],
};
const value = { instanceId: "claude_work", model: "sonnet", effort: "medium" };

const menu = (over: Partial<Parameters<typeof ModelMenu>[0]> = {}) =>
  renderToStaticMarkup(<ModelMenu instances={[work, personal]} models={models} value={value} onPick={noop} add={add} {...over} />);

describe("ModelPicker", () => {
  it("names the instance and model it runs on in the trigger and keeps the list closed", () => {
    const html = renderToStaticMarkup(<ModelPicker instances={[work]} models={models} value={value} onChange={noop} onAddModel={async () => {}} />);
    expect(html).toContain("Claude work · Sonnet");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  it("says to choose a model when the choice names an instance that is gone", () => {
    const html = renderToStaticMarkup(<ModelPicker instances={[work]} models={models} value={{ instanceId: "removed", model: "opus" }} onChange={noop} onAddModel={async () => {}} />);
    expect(html).toContain("Choose a model");
  });
});

describe("ModelMenu", () => {
  it("groups models under their instance and marks the chosen one", () => {
    const html = menu();
    expect(html).toContain('role="group" aria-label="Claude work"');
    expect(html).toMatch(/role="menuitemradio" aria-checked="true"[^>]*>Sonnet</);
    expect(html).toMatch(/role="menuitemradio" aria-checked="false"[^>]*>Opus</);
  });

  it("lists an instance that can't run with its reason and no models to pick", () => {
    const html = menu();
    expect(html).toContain("Claude personal");
    expect(html).toContain("Not signed in");
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(2);
  });

  it("offers Add model… under the chosen instance only", () => {
    expect(menu().match(/Add model…/g)).toHaveLength(1);
    expect(menu({ value: { instanceId: "claude", model: "sonnet" } })).not.toContain("Add model…");
  });

  it("shows the model id field with its refusal while adding", () => {
    const html = menu({ add: { ...add, open: true, id: "bad id", problem: "Use letters, digits and . _ - [ ], starting with a letter or digit, up to 100 characters." } });
    expect(html).toContain('for="f"');
    expect(html).toMatch(/role="alert"[^>]*>Use letters/);
    expect(html).not.toContain("Add model…");
  });

  it("ends with Add or manage… only when Settings can show the instances", () => {
    expect(menu()).not.toContain("Add or manage…");
    expect(menu({ onManage: noop })).toContain("Add or manage…");
  });
});
