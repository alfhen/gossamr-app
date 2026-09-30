import { useMemo, type ReactNode } from "react";
import { parseBlocks, parseInline, type Block, type Inline } from "../lib/markdown";
import { projectsOf } from "../lib/views";
import { useBackend } from "../backend/useBackend";
import { useStore } from "../store";
import { useTicketLinks, type TicketLinks } from "./ticketLinks";
import { Link } from "./Adf";

const HEADING = ["text-[16px]", "text-[15px]", "text-[14px]", "text-[13px]", "text-[13px]", "text-[13px]"];
const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

/** Claude's reply, rendered from Markdown. Ticket keys from known projects open the ticket. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="grid min-w-0 gap-2 [overflow-wrap:anywhere]">{blocks.map(block)}</div>;
}

function block(b: Block, i: number): ReactNode {
  switch (b.type) {
    case "heading": {
      const Tag = `h${Math.min(b.level + 2, 6)}` as "h3";
      return (
        <Tag key={i} className={`mt-1 font-semibold ${HEADING[b.level - 1]}`}>
          <Spans text={b.text} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={i} className="whitespace-pre-line">
          <Spans text={b.text} />
        </p>
      );
    case "code":
      return (
        <pre key={i} className="overflow-x-auto rounded-md border border-sep bg-code px-3 py-2 font-mono text-[12px] leading-[1.5] [overflow-wrap:normal]">
          <code>{b.text}</code>
        </pre>
      );
    case "list": {
      const items = b.items.map((item, j) => (
        <li key={j} className="pl-0.5">
          <div className="grid gap-1">{item.map(block)}</div>
        </li>
      ));
      return b.ordered ? (
        <ol key={i} start={b.start} className="grid list-decimal gap-1 pl-5 marker:text-ink-3">
          {items}
        </ol>
      ) : (
        <ul key={i} className="grid list-disc gap-1 pl-5 marker:text-ink-3">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={i} className="overflow-x-auto rounded-md border border-sep-strong">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {b.head.map((h, c) => (
                  <th key={c} className={`border-b border-sep-strong bg-hover px-2 py-1.5 align-bottom font-semibold ${ALIGN[b.align[c] ?? "left"]}`}>
                    <Spans text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r} className="border-t border-sep first:border-t-0">
                  {row.map((cell, c) => (
                    <td key={c} className={`min-w-[7ch] px-2 py-1.5 align-top ${ALIGN[b.align[c] ?? "left"]}`}>
                      <Spans text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quote":
      return (
        <blockquote key={i} className="grid gap-2 border-l-[3px] border-sep-strong pl-3 text-ink-2">
          {b.blocks.map(block)}
        </blockquote>
      );
    case "rule":
      return <hr key={i} className="border-sep" />;
  }
}

function Spans({ text }: { text: string }) {
  const nodes = useMemo(() => parseInline(text), [text]);
  return <>{nodes.map(span)}</>;
}

function span(n: Inline, i: number): ReactNode {
  switch (n.type) {
    case "text":
      return n.text;
    case "code":
      return (
        <code key={i} className="rounded bg-code px-1 py-px font-mono text-[0.9em]">
          {n.text}
        </code>
      );
    case "strong":
      return (
        <b key={i} className="font-semibold">
          {n.children.map(span)}
        </b>
      );
    case "em":
      return <i key={i}>{n.children.map(span)}</i>;
    case "del":
      return <s key={i}>{n.children.map(span)}</s>;
    case "link":
      return (
        <Link key={i} href={n.href}>
          {n.children.map(span)}
        </Link>
      );
    case "ticket":
      return <TicketKey key={i} ticketKey={n.key} />;
  }
}

/** Opens a synced ticket in the app and any other one in Jira. Keys from projects the user has no tickets in stay text. */
function TicketKey({ ticketKey }: { ticketKey: string }) {
  const links = useTicketLinks();
  return links ? <WorkspaceTicketKey ticketKey={ticketKey} links={links} /> : <ClassicTicketKey ticketKey={ticketKey} />;
}

/** A key the workspace has cached selects that item; any other stays text. */
function WorkspaceTicketKey({ ticketKey, links }: { ticketKey: string; links: TicketLinks }) {
  const title = links.titleOf(ticketKey);
  if (title === null) return <>{ticketKey}</>;
  return (
    <button
      type="button"
      title={`${ticketKey}: ${title}`}
      onClick={() => links.open(ticketKey)}
      className="font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {ticketKey}
    </button>
  );
}

function ClassicTicketKey({ ticketKey }: { ticketKey: string }) {
  const snap = useStore((s) => s.snap);
  const goToTicket = useStore((s) => s.goToTicket);
  const backend = useBackend();
  const known = snap?.tickets[ticketKey];
  const anyTicket = snap && Object.values(snap.tickets)[0];
  if (!snap || (!known && !projectsOf(snap).includes(ticketKey.split("-")[0]))) return <>{ticketKey}</>;
  const url = known?.url ?? anyTicket?.url.replace(/[^/]+$/, ticketKey);
  return (
    <button
      type="button"
      title={known ? `${ticketKey}: ${known.summary}` : `Open ${ticketKey} in Jira`}
      onClick={() => (known ? goToTicket(ticketKey) : url && void backend?.openUrl(url))}
      className="font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {ticketKey}
    </button>
  );
}
