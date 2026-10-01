import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./AgentIcons";
import { usePaneWidths } from "./PaneResizers";

const BUTTON = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm leading-normal whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45";
const TONES = {
  primary: "border-ws-pip bg-ws-pip font-semibold text-ws-on-pip hover:brightness-110",
  plain: "border-ws-sep2 text-ws-ink hover:bg-ws-hover",
  teal: "border-ws-pip text-ws-pip hover:bg-ws-pip-soft",
  danger: "border-ws-blocked text-ws-blocked hover:bg-ws-blocked-soft",
  dangerFill: "border-ws-blocked bg-ws-blocked font-semibold text-white hover:brightness-110",
  ghost: "border-transparent text-ws-ink2 hover:bg-ws-hover",
} as const;

export type ButtonTone = keyof typeof TONES;

export function Btn({ tone = "plain", icon, children, ...rest }: { tone?: ButtonTone; icon?: IconName; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`${BUTTON} ${TONES[tone]} ${rest.className ?? ""}`}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export interface FrameProps {
  label: string;
  title: string;
  hint: ReactNode;
  wide: boolean;
  /** The narrowest the sheet is drawn, in px; the pane width the person chose for the peek applies above it. */
  min?: number;
  draft?: boolean;
  onWide?(): void;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}

/** The frame the agent sheets share with the ticket peek: it slides over the screen from the right. */
export function SheetFrame({ label, title, hint, wide, min = 520, draft = false, onWide, onClose, children, footer }: FrameProps) {
  const peek = usePaneWidths().peek;
  const frame = useRef<HTMLElement>(null);
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  useEffect(() => {
    if (!frame.current?.contains(document.activeElement)) frame.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || frame.current?.contains(document.activeElement))) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return (
    <aside
      ref={frame}
      tabIndex={-1}
      id="agent-sheet"
      role="dialog"
      aria-label={label}
      className={`selectable ws-legacy ws-peek-in outline-none absolute inset-y-0 right-0 z-30 flex max-w-full flex-col border-l border-ws-sep2 bg-ws-win shadow-[-14px_0_40px_rgb(0_0_0/0.16)] ${draft ? "outline-2 -outline-offset-[5px] outline-dashed outline-ws-pip" : ""}`}
      style={{ width: wide ? "100%" : Math.max(peek, min), minWidth: Math.min(min, 360) }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-ws-sep px-3.5 py-2">
        <span className={`shrink-0 font-mono text-sm font-semibold ${draft ? "text-ws-pip" : "text-ws-ink2"}`}>{title}</span>
        <span className="min-w-0 truncate text-xs text-ws-ink3">{hint}</span>
        {onWide && (
          <button type="button" aria-label={wide ? "Shrink" : "Expand"} aria-pressed={wide} title={wide ? "Shrink" : "Expand"} onClick={onWide} className="ml-auto grid size-[26px] place-items-center rounded-md text-[15px] leading-none text-ws-ink3 hover:bg-ws-hover">
            {wide ? "⤡" : "⤢"}
          </button>
        )}
        <button type="button" aria-label="Close" onClick={onClose} className={`${onWide ? "" : "ml-auto "}grid size-[26px] place-items-center rounded-md text-[15px] leading-none text-ws-ink3 hover:bg-ws-hover`}>
          ×
        </button>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-auto px-[22px] pt-4 pb-8">{children}</div>
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

export function BoxTitle({ icon, tone, children }: { icon: IconName; tone: "needs" | "warn" | "failed" | "plain"; children: ReactNode }) {
  const color = { needs: "text-ws-pip", warn: "text-ws-warn", failed: "text-ws-blocked", plain: "text-ws-ink" }[tone];
  return (
    <h4 className={`m-0 flex items-center gap-1.5 text-[13px] font-semibold ${color}`}>
      <Icon name={icon} className="size-[15px]" />
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
    <button
      type="button"
      data-copy={text}
      aria-label={what ? `Copy ${what}` : label}
      onClick={async () => {
        const copied = await copyText(text);
        setState(copied ? "copied" : "failed");
        if (copied) onCopied?.();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1600);
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-xs text-ws-ink2 hover:bg-ws-hover"
    >
      <Icon name={state === "copied" ? "check" : "copy"} className="size-3" />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}</span>
    </button>
  );
}

export function CodeBox({ text, what, wrap = false, onCopied }: { text: string; what: string; wrap?: boolean; onCopied?(): void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-ws-sep bg-ws-bar py-1 pr-1 pl-2.5">
      <code className={`selectable min-w-0 flex-1 py-0.5 font-mono text-sm text-ws-ink ${wrap ? "break-words whitespace-pre-wrap" : "truncate"}`} title={wrap ? undefined : text}>
        {text}
      </code>
      <CopyButton text={text} what={what} onCopied={onCopied} />
    </div>
  );
}

export function Details({ summary, children, onToggle }: { summary: ReactNode; children: ReactNode; onToggle?(open: boolean): void }) {
  return (
    <details className="group" onToggle={onToggle ? (ev) => onToggle((ev.currentTarget as HTMLDetailsElement).open) : undefined}>
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
