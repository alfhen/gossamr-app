import { useEffect, useRef, useState } from "react";
import { messageOf, useToasts } from "../workspace/toasts";

const COPIED_MS = 1500;

export interface ClipboardDeps {
  writeText?: (text: string) => Promise<void>;
  execCopy: (text: string) => boolean;
}

/** Copies through the async clipboard API, then a hidden textarea when it is missing or refuses (as in some webviews). */
export async function copyText(text: string, deps: ClipboardDeps): Promise<void> {
  if (deps.writeText) {
    try {
      await deps.writeText(text);
      return;
    } catch {
      // fall through to the textarea copy
    }
  }
  if (!deps.execCopy(text)) throw new Error("Couldn't copy to the clipboard");
}

function execCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus();
  }
}

export const browserDeps =(): ClipboardDeps => ({
  writeText: navigator.clipboard?.writeText ? (t) => navigator.clipboard.writeText(t) : undefined,
  execCopy,
});

/** A fenced block of Markdown with a button that copies its text exactly as written. */
export function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await copyText(text, browserDeps());
    } catch (e) {
      useToasts.getState().push(`Couldn't copy: ${messageOf(e)}`);
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  const button = (
    <button
      type="button"
      aria-label="Copy code"
      onClick={() => void copy()}
      className={`flex items-center gap-1 rounded-md border border-ws-sep2 bg-ws-win px-1.5 py-0.5 text-xs font-medium text-ws-ink2 opacity-0 transition-opacity hover:text-ws-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ws-accent group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100`}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {copied ? (
          <path d="m3.5 8.5 3 3 6-7" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
          </>
        )}
      </svg>
      {copied ? "Copied" : "Copy"}
    </button>
  );

  return (
    <div className="group min-w-0 overflow-hidden rounded-md border border-sep bg-code">
      <div className="flex items-center justify-between gap-2 border-b border-sep px-3 py-1 text-xs text-ws-ink3">
        <span className="min-w-0 truncate font-mono">{lang || "code"}</span>
        {button}
      </div>
      <pre tabIndex={0} className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.5] [overflow-wrap:normal]">
        <code>{text}</code>
      </pre>
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
