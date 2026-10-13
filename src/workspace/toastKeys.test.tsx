import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToastCard, focusToast } from "./ToastHost";
import type { Toast } from "./toasts";

const toast: Toast = { id: 1, text: "Kept your plan for 2026-W42.", tone: "info", at: 0 };

/** The card's own props, without a DOM: its key handler is what Esc runs. */
const props = (onDismiss = () => undefined) => {
  const card = ToastCard({ toast, waiting: 0, onDismiss }) as ReactElement<{ onKeyDown(ev: unknown): void; tabIndex: number }>;
  expect(isValidElement(card)).toBe(true);
  return card.props;
};
const esc = (over: Record<string, unknown> = {}) => ({ key: "Escape", defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over });

describe("a toast takes the keyboard", () => {
  it("can be focused (not a Tab stop), is marked as keeping Esc to itself, and says Esc and F6", () => {
    const html = renderToStaticMarkup(<ToastCard toast={toast} waiting={0} onDismiss={() => undefined} />);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("data-esc-local");
    expect(html).toContain('aria-keyshortcuts="Escape F6"');
    expect(html).toContain("Esc when the toast has the keyboard");
  });

  it("dismisses on Esc, once, and keeps the key from the page behind it", () => {
    const dismiss = vi.fn();
    const ev = esc();
    props(dismiss).onKeyDown(ev);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();
  });

  it("ignores other keys, and an Esc something nearer already took", () => {
    const dismiss = vi.fn();
    props(dismiss).onKeyDown(esc({ key: "Enter" }));
    props(dismiss).onKeyDown(esc({ defaultPrevented: true }));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("is where F6 lands: the toast on screen gets focus, and none means no stop", () => {
    const focus = vi.fn();
    const found = { focus, contains: () => false };
    expect(focusToast({ querySelector: () => found as unknown as HTMLElement, activeElement: null })).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focusToast({ querySelector: () => null, activeElement: null })).toBe(false);
  });
});
