import type { ReactNode } from "react";
import { Link } from "../components/Adf";
import type { WorkBlock, WorkDoc, WorkInline } from "../types";

function inline(i: WorkInline, at: number): ReactNode {
  switch (i.type) {
    case "lineBreak":
      return <br key={at} />;
    case "link":
      return (
        <Link key={at} href={i.href}>
          {i.text}
        </Link>
      );
    case "mention":
      return (
        <span key={at} className="rounded bg-ws-accent-soft px-1 font-semibold text-ws-accent">
          @{i.name}
        </span>
      );
    case "text": {
      let out: ReactNode = i.text;
      if (i.marks.includes("code")) out = <code className="rounded bg-ws-hover px-1 font-mono text-[0.92em]">{out}</code>;
      if (i.marks.includes("bold")) out = <strong>{out}</strong>;
      if (i.marks.includes("italic")) out = <em>{out}</em>;
      if (i.marks.includes("strike")) out = <s>{out}</s>;
      return <span key={at}>{out}</span>;
    }
  }
}

function block(b: WorkBlock, at: number): ReactNode {
  switch (b.type) {
    case "paragraph":
      return <p key={at}>{b.content.map(inline)}</p>;
    case "heading":
      return (
        <h4 key={at} className="mt-1 font-semibold">
          {b.content.map(inline)}
        </h4>
      );
    case "list": {
      const List = b.ordered ? "ol" : "ul";
      return (
        <List key={at} className={`m-0 grid gap-1 pl-5 ${b.ordered ? "list-decimal" : "list-disc"}`}>
          {b.items.map((item, i) => (
            <li key={i}>{item.map(block)}</li>
          ))}
        </List>
      );
    }
    case "quote":
      return (
        <blockquote key={at} className="m-0 grid gap-1 border-l-2 border-ws-sep2 pl-3 text-ws-ink2">
          {b.content.map(block)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={at} className="m-0 overflow-x-auto rounded-md bg-ws-hover p-2.5 font-mono text-sm">
          {b.text}
        </pre>
      );
    case "rule":
      return <hr key={at} className="w-full border-ws-sep" />;
  }
}

export function WorkDocView({ doc }: { doc: WorkDoc }) {
  return <div className="grid gap-2 [overflow-wrap:anywhere]">{doc.blocks.map(block)}</div>;
}
