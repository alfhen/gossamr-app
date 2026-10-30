import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./AgentIcons";
import { usePaneWidths } from "./PaneResizers";
import { PipGlyph } from "../components/PipGlyph";
import { Button, type ButtonProps } from "../components/Button";

const TONES = {
  primary: { variant: "primary" },
  plain: { variant: "secondary" },
  teal: { variant: "pip" },
  danger: { variant: "secondary", destructive: true },
  dangerFill: { variant: "danger" },
  ghost: { variant: "quiet" },
} as const satisfies Record<string, Pick<ButtonProps, "variant" | "destructive">>;

export type ButtonTone = keyof typeof TONES;

export function Btn({ tone = "plain", icon, children, ...rest }: { tone?: ButtonTone; icon?: IconName; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button {...rest} {...TONES[tone]}>
      {icon && <Icon name={icon} />}
      {children}
    </Button>
  );
}

export interface FrameProps {
  /** The element's id; the one sheet over a screen is `agent-sheet`, and a second one under it (a workstream's detail) has its own. */
  id?: string;
  label: string;
  title: string;
  hint: ReactNode;
  wide: boolean;
  /** The narrowest the sheet is drawn, in px; the pane width the person chose for the peek applies above it. */
  min?: number;
  draft?: boolean;
  /** Docked in the page beside what it belongs to, as a column, rather than sliding over it from the right. */
  docked?: boolean;
  onWide?(): void;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  /** When this changes, the body scrolls back to the top, so a new state shows with the title above it. */
  topOn?: unknown;
}

/**
 * Whether a picker is open over the screen, a palette or a mention list, which takes Esc and Enter itself. A combobox
 * that is closed, such as the peek's comment box behind a sheet, is not one.
 */
export const pickerOpen = () => !!document.querySelector('[role=combobox][aria-expanded="true"]');

/**
 * Where focus goes as a sheet closes, when it is on the sheet or nowhere: the element that opened it, else (the Needs you
 * row that opened it is gone once its ask is denied) the tray, rather than the page.
 */
export function sheetFocusTarget<T extends { isConnected: boolean }>(opener: T | null, lost: boolean, tray: () => T | null): T | null {
  if (!lost) return null;
  return opener?.isConnected ? opener : tray();
}

/** The frame the agent sheets share with the ticket peek: it slides over the screen from the right. */
export function SheetFrame({ id = "agent-sheet", label, title, hint, wide, min = 520, draft = false, docked = false, onWide, onClose, children, footer, topOn }: FrameProps) {
  const peek = usePaneWidths().peek;
  const frame = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const firstTop = useRef(true);
  useEffect(() => {
    if (firstTop.current) return void (firstTop.current = false);
    body.current?.scrollTo?.({ top: 0 });
  }, [topOn]);
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    if (!frame.current?.contains(document.activeElement)) frame.current?.focus({ preventScroll: true });
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body || !!frame.current?.contains(document.activeElement);
      sheetFocusTarget(opener, lost, () => document.querySelector<HTMLElement>("[data-needs-you-group], [data-needs-you-need], [data-needs-you-title]"))?.focus({ preventScroll: true });
    };
  }, [opener]);
  return (
    <aside
      ref={frame}
      tabIndex={-1}
      id={id}
      role="dialog"
      aria-label={label}
      className={`selectable ws-legacy outline-none flex max-w-full flex-col border-l border-ws-sep2 bg-ws-win ${docked ? "relative h-full shrink-0" : "ws-peek-in absolute inset-y-0 right-0 z-30 shadow-[-14px_0_40px_rgb(0_0_0/0.16)]"} ${draft ? "outline-2 -outline-offset-[5px] outline-dashed outline-ws-pip" : ""}`}
      style={{ width: wide && !docked ? "100%" : Math.max(peek, min), minWidth: Math.min(min, 360) }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-ws-sep px-3.5 py-2">
        <span className={`shrink-0 font-mono text-sm font-semibold ${draft ? "text-ws-pip" : "text-ws-ink2"}`}>{title}</span>
        <span className="min-w-0 truncate text-xs text-ws-ink3">{hint}</span>
        {onWide && (
          <Button variant="quiet" size="sm" iconOnly className="ml-auto" aria-label={wide ? "Shrink" : "Expand"} aria-pressed={wide} title={wide ? "Shrink" : "Expand"} onClick={onWide}>
            {wide ? "⤡" : "⤢"}
          </Button>
        )}
        <Button variant="quiet" size="sm" iconOnly aria-label="Close" onClick={onClose} className={onWide ? "" : "ml-auto"}>
          ×
        </Button>
      </div>
      <div ref={body} data-sheet-body className="grid min-h-0 flex-1 content-start gap-5 overflow-auto px-[22px] pt-4 pb-8">
        {children}
      </div>
      {footer && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-ws-sep bg-ws-win px-[22px] py-2.5">{footer}</div>}
    </aside>
  );
}

export function Sec({ title, count, aside, id, children }: { title: string; count?: ReactNode; aside?: ReactNode; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="grid gap-2">
      <h3 className="m-0 flex items-center gap-2 text-xs font-semibold tracking-[0.05em] text-ws-ink3 uppercase">
        {title}
        {count !== undefined && <span className="font-normal normal-case">{count}</span>}
        {aside && <span className="ml-auto font-normal normal-case">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

const BOX = {
  plain: "border-ws-sep bg-ws-win",
  needs: "border-ws-pip bg-ws-pip-soft",
  warn: "border-ws-warn bg-ws-warn/10",
  failed: "border-ws-blocked bg-ws-blocked-soft",
  draft: "border-dashed border-ws-pip bg-ws-pip-soft",
} as const;

export function Box({ tone = "plain", label, children }: { tone?: keyof typeof BOX; label?: string; children: ReactNode }) {
  return (
    <div role={label ? "group" : undefined} aria-label={label} className={`grid gap-2 rounded-[10px] border px-3.5 py-2.5 ${tone === "plain" ? "" : "border-[1.5px]"} ${BOX[tone]}`}>
      {children}
    </div>
  );
}

export function BoxTitle({ icon, tone, children }: { icon: IconName | "pip"; tone: "needs" | "warn" | "failed" | "plain"; children: ReactNode }) {
  const color = { needs: "text-ws-pip", warn: "text-ws-warn", failed: "text-ws-blocked", plain: "text-ws-ink" }[tone];
  return (
    <h4 className={`m-0 flex items-center gap-1.5 text-[13px] font-semibold ${color}`}>
      {icon === "pip" ? <PipGlyph className="size-[15px]" /> : <Icon name={icon} className="size-[15px]" />}
      {children}
    </h4>
  );
}

/** Puts `text` on the clipboard. Resolves false where there is no clipboard to write to. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = "Copy", what, onCopied }: { text: string; label?: string; what?: string; onCopied?(): void }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button variant="plain" size="sm" className="shrink-0" data-copy={text} aria-label={what ? `Copy ${what}` : label} onClick={async () => { const copied = await copyText(text); setState(copied ? "copied" : "failed"); if (copied) onCopied?.(); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setState("idle"), 1600); }}>
      <Icon name={state === "copied" ? "check" : "copy"} className="size-3" />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}</span>
    </Button>
  );
}

export function CodeBox({ text, what, wrap = false, copy = true, onCopied }: { text: string; what: string; wrap?: boolean; copy?: boolean; onCopied?(): void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-ws-sep bg-ws-bar py-1 pr-1 pl-2.5">
      {/* Copying it by hand, selected, counts as much as the button does. */}
      <code onCopy={onCopied} className={`selectable min-w-0 flex-1 py-0.5 font-mono text-sm text-ws-ink ${wrap ? "break-words whitespace-pre-wrap" : "truncate"}`} title={wrap ? undefined : text}>
        {text}
      </code>
      {copy && <CopyButton text={text} what={what} onCopied={onCopied} />}
    </div>
  );
}

export function Details({ summary, children, onToggle, open }: { summary: ReactNode; children: ReactNode; onToggle?(open: boolean): void; open?: boolean }) {
  return (
    <details className="group" open={open} onToggle={onToggle ? (ev) => onToggle((ev.currentTarget as HTMLDetailsElement).open) : undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-ws-ink2 marker:hidden [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 16 16" className="size-3 shrink-0 fill-none stroke-current transition-transform group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 4l4 4-4 4" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2 grid gap-2">{children}</div>
    </details>
  );
}

export const MONO_BLOCK = "selectable m-0 max-h-72 overflow-auto rounded-md border border-ws-sep bg-ws-bar px-2.5 py-1.5 font-mono text-sm leading-normal break-words whitespace-pre-wrap text-ws-ink2";
