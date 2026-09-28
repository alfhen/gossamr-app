import type { ReactNode } from "react";
import type { AdfMark, AdfNode } from "../types";
import { useStore } from "../store";

const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * Renders a Jira document (ADF). Only known node types produce markup; anything else renders its children, so
 * unfamiliar content degrades to its text rather than disappearing.
 */
export function Adf({ doc }: { doc: AdfNode }) {
  return <div className="adf grid max-w-[65ch] gap-2">{children(doc)}</div>;
}

function children(node: AdfNode): ReactNode {
  return node.content?.map((c, i) => <Node key={i} node={c} />);
}

function Node({ node }: { node: AdfNode }): ReactNode {
  const a = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      return <p className="min-h-[1lh] whitespace-pre-wrap">{children(node)}</p>;
    case "heading": {
      const size = ["", "text-xl", "text-lg", "text-base", "text-base", "text-sm", "text-sm"][Number(a.level) || 3];
      return <p className={`mt-1 font-semibold ${size}`}>{children(node)}</p>;
    }
    case "text":
      return <Text text={node.text ?? ""} marks={node.marks ?? []} />;
    case "hardBreak":
      return <br />;
    case "bulletList":
      return <ul className="grid list-disc gap-0.5 pl-5">{children(node)}</ul>;
    case "orderedList":
      return (
        <ol start={Number(a.order) || 1} className="grid list-decimal gap-0.5 pl-5">
          {children(node)}
        </ol>
      );
    case "listItem":
      return <li className="[&>p]:min-h-0">{children(node)}</li>;
    case "codeBlock":
      return (
        <pre className="overflow-x-auto rounded-md border border-sep bg-code px-3 py-2 font-mono text-[12.5px] leading-[1.5]">
          <code>{node.content?.map((c) => c.text ?? "").join("")}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote className="grid gap-2 border-l-[3px] border-sep-strong pl-3 text-ink-2">{children(node)}</blockquote>;
    case "rule":
      return <hr className="border-sep" />;
    case "panel":
      return <div className={`grid gap-2 rounded-md px-3 py-2 ${PANEL[String(a.panelType)] ?? PANEL.info}`}>{children(node)}</div>;
    case "expand":
    case "nestedExpand":
      return (
        <details className="rounded-md border border-sep px-3 py-1.5">
          <summary className="cursor-pointer font-medium">{String(a.title || "Details")}</summary>
          <div className="grid gap-2 pt-2">{children(node)}</div>
        </details>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="border-collapse text-sm">
            <tbody>{children(node)}</tbody>
          </table>
        </div>
      );
    case "tableRow":
      return <tr>{children(node)}</tr>;
    case "tableHeader":
      return (
        <th {...spans(a)} className="border border-sep-strong bg-hover px-2 py-1 text-left align-top font-semibold [&>p]:min-h-0">
          {children(node)}
        </th>
      );
    case "tableCell":
      return (
        <td {...spans(a)} className="border border-sep-strong px-2 py-1 align-top [&>p]:min-h-0">
          {children(node)}
        </td>
      );
    case "taskList":
    case "decisionList":
      return <ul className="grid gap-1">{children(node)}</ul>;
    case "taskItem":
      return (
        <li className="flex items-start gap-2">
          <input type="checkbox" checked={a.state === "DONE"} readOnly tabIndex={-1} className="mt-1" />
          <span className="whitespace-pre-wrap">{children(node)}</span>
        </li>
      );
    case "decisionItem":
      return (
        <li className="flex items-start gap-2">
          <span className="text-done">◆</span>
          <span className="whitespace-pre-wrap">{children(node)}</span>
        </li>
      );
    case "mention":
      return <span className="rounded-[4px] bg-accent-soft px-0.5 font-medium text-accent">{String(a.text || "@someone")}</span>;
    case "emoji":
      return <>{String(a.text ?? a.shortName ?? "")}</>;
    case "status":
      return (
        <span className="rounded-[4px] bg-todo-bg px-1.5 py-px text-[11px] font-semibold tracking-wide text-todo uppercase">{String(a.text ?? "")}</span>
      );
    case "date": {
      const d = dateOf(a.timestamp);
      return (
        <span className="rounded-[4px] bg-hover px-1">
          {d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : ""}
        </span>
      );
    }
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return typeof a.url === "string" ? <Link href={a.url}>{a.url}</Link> : null;
    case "mediaSingle":
    case "mediaGroup":
    case "mediaInline":
      return <span className="text-sm text-ink-3">[Attachment. Open in Jira to view]</span>;
    case "media":
      return null;
    default:
      return <>{children(node)}</>;
  }
}

function spans(a: Record<string, unknown>) {
  const span = (v: unknown) => (Number.isInteger(v) && (v as number) > 1 ? (v as number) : undefined);
  return { colSpan: span(a.colspan), rowSpan: span(a.rowspan) };
}

/** A date node's day, which is midnight UTC. The spec's example is in seconds; Jira's editor writes milliseconds. */
export function dateOf(timestamp: unknown): Date | null {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e11 ? n * 1000 : n);
}

const PANEL: Record<string, string> = {
  info: "bg-progress-bg",
  note: "bg-review-bg",
  success: "bg-done-bg",
  warning: "bg-warn-bg",
  error: "bg-blocked-bg",
  tip: "bg-done-bg",
};

function Text({ text, marks }: { text: string; marks: AdfMark[] }) {
  let out: ReactNode = text;
  for (const m of marks) {
    switch (m.type) {
      case "strong":
        out = <b className="font-semibold">{out}</b>;
        break;
      case "em":
        out = <i>{out}</i>;
        break;
      case "strike":
        out = <s>{out}</s>;
        break;
      case "underline":
        out = <u>{out}</u>;
        break;
      case "code":
        out = <code className="rounded bg-code px-1 py-px font-mono text-[0.9em]">{out}</code>;
        break;
      case "subsup":
        out = m.attrs?.type === "sup" ? <sup>{out}</sup> : <sub>{out}</sub>;
        break;
      case "link":
        if (typeof m.attrs?.href === "string") out = <Link href={m.attrs.href}>{out}</Link>;
        break;
    }
  }
  return <>{out}</>;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const backend = useStore((s) => s.backend);
  if (!SAFE_URL.test(href)) return <>{children}</>;
  return (
    <a
      href={href}
      onClick={(e) => {
        // Following the link would navigate the app's own window; open it in the browser instead.
        e.preventDefault();
        void backend?.openUrl(href);
      }}
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  );
}
