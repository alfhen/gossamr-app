import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentsSettingsView } from "./AgentsSettings";
import { trapTab } from "./AgentSheet";

const tab = (over: Partial<{ shiftKey: boolean; metaKey: boolean }> = {}) => ({ key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...over });
const control = (name: string) => ({ name, getClientRects: () => [{}] }) as unknown as HTMLElement;

describe("keeping Tab inside the first-run safety sheet (G27)", () => {
  const [close, details, gotIt] = [control("close"), control("details"), control("got it")];
  const frame = { querySelectorAll: () => [close, details, gotIt, { getClientRects: () => [] }] } as unknown as Pick<HTMLElement, "querySelectorAll">;

  it("wraps from the last control to the first and from the first, or the frame itself, back to the last with Shift", () => {
    expect(trapTab(tab(), frame, gotIt)).toBe(close);
    expect(trapTab(tab({ shiftKey: true }), frame, close)).toBe(gotIt);
    expect(trapTab(tab({ shiftKey: true }), frame, null)).toBe(gotIt);
  });

  it("leaves the Tabs between to the browser, and every other key, and a control in a closed disclosure is not in the order", () => {
    expect(trapTab(tab(), frame, close)).toBeNull();
    expect(trapTab(tab(), frame, details)).toBeNull();
    expect(trapTab(tab({ shiftKey: true }), frame, details)).toBeNull();
    expect(trapTab({ ...tab(), key: "Enter" }, frame, gotIt)).toBeNull();
    expect(trapTab(tab({ metaKey: true }), frame, gotIt)).toBeNull();
    expect(trapTab(tab(), { querySelectorAll: () => [] } as unknown as Pick<HTMLElement, "querySelectorAll">, null)).toBeNull();
  });

  it("is modal on the first run only, and the settings opened later are not", () => {
    const view = (intro: boolean) => renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={null} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} intro={intro} />);
    expect(view(true)).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    expect(view(false)).not.toContain("aria-modal");
  });
});
