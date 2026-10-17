import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToastCard, ToastStack, focusToast, roundStart } from "./ToastHost";
import type { Toast } from "./toasts";

const toast: Toast = { id: 1, text: "Kept your plan for 2026-W42.", tone: "info", at: 0 };

/** The card's own props, without a DOM: its key handler is what Esc runs. */
const props = (onDismiss = () => undefined) => {
  const card = ToastCard({ toast, waiting: 0, onDismiss }) as ReactElement<{ onKeyDown(ev: unknown): void; tabIndex: number }>;
  expect(isValidElement(card)).toBe(true);
  return card.props;
};
const esc = (over: Record<string, unknown> = {}) => ({ key: "Escape", defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over });

describe("a toast's Undo names what it undoes (G29)", () => {
  it("reads 'Undo keep waiting' on the button, with the toast's words in its name, while the label stays Undo", () => {
    const named: Toast = { id: 2, text: "Waiting on CA-377; it is out of Needs you for now.", tone: "info", at: 0, action: { label: "Undo", what: "keep waiting", run: () => undefined } };
    const html = renderToStaticMarkup(<ToastCard toast={named} waiting={2} onDismiss={() => undefined} />);
    expect(html).toContain("+2 more");
    expect(html).toMatch(/<button[^>]*data-toast-action="Undo"[^>]*aria-label="Undo keep waiting: Waiting on CA-377[^"]*"[^>]*>Undo keep waiting<\/button>/);
    // Without a name it is the plain button it was.
    const plain = renderToStaticMarkup(<ToastCard toast={{ ...named, action: { label: "Undo", run: () => undefined } }} waiting={0} onDismiss={() => undefined} />);
    expect(plain).toMatch(/aria-label="Undo: Waiting on CA-377[^"]*"[^>]*>Undo<\/button>/);
  });
});

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

  it("puts the keyboard on the toast's Undo, so Enter runs it, and on the toast itself when it has none (G12)", () => {
    const undo = { focus: vi.fn() };
    const el = { focus: vi.fn(), contains: () => false, querySelector: vi.fn(() => undo) };
    expect(focusToast({ querySelector: () => el as unknown as HTMLElement, activeElement: null })).toBe(true);
    expect(el.querySelector).toHaveBeenCalledWith("[data-toast-action]:not(:disabled)");
    expect(undo.focus).toHaveBeenCalledTimes(1);
    expect(el.focus).not.toHaveBeenCalled();
    el.querySelector.mockReturnValue(null as never);
    focusToast({ querySelector: () => el as unknown as HTMLElement, activeElement: null });
    expect(el.focus).toHaveBeenCalledTimes(1);
  });

  it("hands the keyboard back when its × is used after F6 took the keyboard there, as Esc does", () => {
    const dismiss = vi.fn();
    const back = { focus: vi.fn(), isConnected: true };
    focusToast({ querySelector: () => ({ focus: vi.fn(), contains: () => false }) as unknown as HTMLElement, activeElement: back as unknown as Element });
    const card = ToastCard({ toast, waiting: 0, onDismiss: dismiss }) as ReactElement<{ children: unknown[] }>;
    const x = (card.props.children as ReactElement<{ "aria-label"?: string; onClick(): void }>[]).find((c) => isValidElement(c) && (c.props as { "aria-label"?: string })["aria-label"] === "Dismiss")!;
    x.props.onClick();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(back.focus).toHaveBeenCalledTimes(1);
    // A second click, not through F6, dismisses and moves nothing.
    x.props.onClick();
    expect(back.focus).toHaveBeenCalledTimes(1);
  });
});

describe("where Esc on the toast gives the keyboard back (G21)", () => {
  it("is the place the round of F6 began, not the composer the round passed on its way to the toast", () => {
    // First press from the plan row: the round begins there. Later presses in the same round keep it, wherever focus is by then.
    expect(roundStart("row", false, null)).toBe("row");
    expect(roundStart("notice", true, "row")).toBe("row");
    expect(roundStart("row", true, "row")).toBe("row");
    // Another key or a click ended the round: the next F6 begins a new one, from there.
    expect(roundStart("field", false, "row")).toBe("field");
    // The page itself is no place to go back to.
    expect(roundStart("body", false, null, "body")).toBeNull();
  });

  it("falls back to where the keyboard is when F6 reaches the toast, when no round was noted", () => {
    const composer = { focus: vi.fn(), isConnected: true };
    const found = { focus: vi.fn(), contains: () => false };
    focusToast({ querySelector: () => found as unknown as HTMLElement, activeElement: composer as unknown as Element });
    props().onKeyDown(esc());
    // No window here, so no round was noted.
    expect(composer.focus).toHaveBeenCalledTimes(1);
  });
});

describe("the toast's live region (G5)", () => {
  it("holds the message alone, with no button inside it, and names the action by its toast", () => {
    const held: Toast = { id: 2, text: "Held CA-408.", tone: "info", at: 0, action: { label: "Undo", run: () => undefined } };
    const html = renderToStaticMarkup(<ToastStack toasts={[held]} dismiss={() => undefined} />);
    const live = html.match(/<p role="status"[^>]*>(.*?)<\/p>/);
    expect(live?.[1]).toBe("Held CA-408.");
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Undo: Held CA-408."');
  });
});
