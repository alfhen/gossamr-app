import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdfNode } from "../types";
import { Adf, dateOf } from "./Adf";

const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", content });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const text = (t: string, ...marks: string[]): AdfNode => ({ type: "text", text: t, marks: marks.map((type) => ({ type })) });
const html = (d: AdfNode) => renderToStaticMarkup(<Adf doc={d} />);

describe("Adf", () => {
  it("keeps code blocks as preformatted code", () => {
    const out = html(doc({ type: "codeBlock", content: [text("User::firstOrCreate(\n  ['email' => $email],\n);")] }));
    expect(out).toContain("<pre");
    expect(out).toContain("User::firstOrCreate(\n  [&#x27;email&#x27; =&gt; $email],\n);");
  });

  it("renders inline marks", () => {
    const out = html(doc(p(text("bold", "strong"), text("code", "code"), text("gone", "strike"))));
    expect(out).toMatch(/<b[^>]*>bold<\/b>/);
    expect(out).toMatch(/<code[^>]*>code<\/code>/);
    expect(out).toContain("<s>gone</s>");
  });

  it("links only web and mail addresses", () => {
    const link = (href: string): AdfNode => ({ type: "text", text: "here", marks: [{ type: "link", attrs: { href } }] });
    expect(html(doc(p(link("https://example.com"))))).toContain('href="https://example.com"');
    expect(html(doc(p(link("javascript:alert(1)"))))).not.toContain("href");
  });

  it("shows mentions and falls back to the text of unknown nodes", () => {
    const out = html(doc(p({ type: "mention", attrs: { id: "1", text: "@Sam Holt" } }), { type: "somethingNew", content: [p(text("still here"))] }));
    expect(out).toContain("@Sam Holt");
    expect(out).toContain("still here");
  });

  it("keeps merged table cells", () => {
    const cell = (type: string, attrs = {}): AdfNode => ({ type, attrs, content: [p(text("x"))] });
    const out = html(doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", { colspan: 2 }), cell("tableCell", { rowspan: 1 })] }] }));
    expect(out).toContain('colspan="2"');
    expect(out).not.toContain("rowspan");
  });

  it("reads date timestamps in seconds or milliseconds", () => {
    expect(dateOf("1582152559")?.toISOString()).toBe("2020-02-19T22:49:19.000Z");
    expect(dateOf("1582070400000")?.toISOString()).toBe("2020-02-19T00:00:00.000Z");
    expect(dateOf("nope")).toBeNull();
  });
});
