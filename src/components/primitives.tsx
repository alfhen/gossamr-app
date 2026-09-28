import type { ReactNode } from "react";
import { initials, statusTone, type StatusTone } from "../lib/views";
import type { Person, Status } from "../types";
import { Icon } from "./icons";

const TONE: Record<StatusTone, string> = {
  todo: "bg-todo-bg text-todo",
  progress: "bg-progress-bg text-progress",
  review: "bg-review-bg text-review",
  blocked: "bg-blocked-bg text-blocked",
  done: "bg-done-bg text-done",
};

export function StatusPill({ status, onClick }: { status: Status; onClick?: () => void }) {
  const cls = `inline-flex items-center gap-1 rounded-md font-semibold whitespace-nowrap ${TONE[statusTone(status)]}`;
  if (!onClick) return <span className={`${cls} px-1.5 py-px text-xs`}>{status.name}</span>;
  return (
    <button type="button" onClick={onClick} className={`${cls} px-2 py-0.5 text-sm`} title="Transition (t)">
      {status.name}
      <Icon name="chevron" className="size-3 opacity-70" />
    </button>
  );
}

const HUES = [214, 22, 270, 152, 338, 190, 40];

export function Avatar({ person, size = 20 }: { person: Person | null; size?: number }) {
  const name = person?.name ?? "Unassigned";
  const hue = person ? HUES[[...person.accountId].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length] : null;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (person?.avatarUrl) {
    return <img src={person.avatarUrl} alt="" title={name} style={style} className="shrink-0 rounded-full" />;
  }
  return (
    <span
      title={name}
      style={{ ...style, background: hue === null ? "#9a9aa2" : `hsl(${hue} 60% 48%)` }}
      className="inline-grid shrink-0 place-items-center rounded-full font-bold text-white"
    >
      {person ? initials(name) : "–"}
    </span>
  );
}

export function ToolbarButton({
  children,
  onClick,
  title,
  variant = "plain",
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
  variant?: "plain" | "claude";
  disabled?: boolean;
}) {
  const look =
    variant === "claude"
      ? "border-transparent bg-claude-soft font-semibold text-claude"
      : "border-field-border bg-field hover:bg-hover";
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] whitespace-nowrap disabled:opacity-50 ${look}`}
    >
      {children}
    </button>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">{children}</h3>;
}
