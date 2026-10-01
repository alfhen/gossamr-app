import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CodeBlock, copyText } from "./CodeBlock";
import { Markdown } from "./Markdown";

describe("copyText", () => {
  it("writes the text unchanged through the clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCopy = vi.fn();
    await copyText("  a\n\tb  ", { writeText, execCopy });
    expect(writeText).toHaveBeenCalledWith("  a\n\tb  ");
    expect(execCopy).not.toHaveBeenCalled();
  });

  it("falls back to the textarea copy when the API is missing or rejects", async () => {
    const execCopy = vi.fn().mockReturnValue(true);
    await copyText("x", { execCopy });
    await copyText("y", { writeText: () => Promise.reject(new Error("denied")), execCopy });
    expect(execCopy.mock.calls).toEqual([["x"], ["y"]]);
  });

  it("fails when both ways fail", async () => {
    await expect(copyText("x", { execCopy: () => false })).rejects.toThrow("Couldn't copy");
  });
});

describe("CodeBlock", () => {
  it("renders a labelled copy button and a live status", () => {
    const out = renderToStaticMarkup(<CodeBlock text="a < b" />);
    expect(out).toMatch(/<button[^>]*type="button"[^>]*aria-label="Copy code"/);
    expect(out).toContain('role="status"');
    expect(out).toContain("<code>a &lt; b</code>");
  });

  it("labels the header row with the language, or a generic label without one", () => {
    expect(renderToStaticMarkup(<CodeBlock text="ls" lang="sh" />)).toContain(">sh</span>");
    expect(renderToStaticMarkup(<CodeBlock text="ls" />)).toContain(">code</span>");
  });

  it("is used for fenced blocks in Markdown, without the trailing newline", () => {
    const out = renderToStaticMarkup(<Markdown text={"```\nline one\n  line two\n```"} />);
    expect(out).toContain("<code>line one\n  line two</code>");
    expect(out).toContain('aria-label="Copy code"');
  });
});
