import type { EventKind, ViewId } from "../types";

const P = {
  inbox: <path d="M2 9h3.5l1 2h3l1-2H14M3.5 3h9L14 9v4H2V9z" strokeLinejoin="round" />,
  at: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M10.6 8v1.2a1.8 1.8 0 0 0 3.6 0V8A6.2 6.2 0 1 0 11 13.4" strokeLinecap="round" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.8" />
      <path d="M2.5 14c.6-2.8 2.8-4.2 5.5-4.2s4.9 1.4 5.5 4.2" strokeLinecap="round" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.3 8.2 1.8 1.8 3.6-3.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  comment: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />,
  status: <path d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />,
  assigned: (
    <>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M1.8 13.5c.5-2.4 2.4-3.6 4.7-3.6M11.5 9v5M9 11.5h5" strokeLinecap="round" />
    </>
  ),
  field: <path d="M3 12.5 3.5 10 10.5 3l2.5 2.5-7 7z" strokeLinejoin="round" />,
  hourglass: <path d="M4.5 2.5h7M4.5 13.5h7M5.5 2.5V4L8 8l2.5-4V2.5M5.5 13.5V12L8 8l2.5 4v1.5" strokeLinecap="round" strokeLinejoin="round" />,
  leaf: (
    <>
      <path d="M13.5 2.5C7.5 2.5 3 5.5 3 10.5c0 1.2.3 2.1.8 2.8 1-3 3.3-5.3 6.2-6.6-2.4 1.8-4.2 4.1-5 6.7C10.9 13.4 13.5 9.2 13.5 2.5z" strokeLinejoin="round" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" strokeLinecap="round" />
    </>
  ),
  chevron: <path d="M4.5 6.5 8 10l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />,
  external: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" strokeLinecap="round" strokeLinejoin="round" />,
};

export type IconName = keyof typeof P;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      {P[name]}
    </svg>
  );
}

export function Sparkle({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0l1.6 5.2L15 6.9 9.9 8.6 8 14l-1.8-5.4L1 6.9l5.3-1.7z" />
    </svg>
  );
}

export const VIEW_ICON: Record<ViewId, IconName> = {
  inbox: "inbox",
  waiting: "hourglass",
  watching: "eye",
  work: "user",
  snoozed: "clock",
  done: "check",
};

export const EVENT_ICON: Record<EventKind, IconName> = {
  mention: "at",
  comment: "comment",
  status: "status",
  assigned: "assigned",
  field: "field",
};
