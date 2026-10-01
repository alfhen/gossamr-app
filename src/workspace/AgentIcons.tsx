import type { RunKind } from "../types";
import type { RunIcon } from "./agentsLogic";

const PATHS = {
  hand: "M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V11m0-3.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 6.5-6 6.5-3 0-4.5-1.5-6-4.5l-1.3-2.6a1.4 1.4 0 0 1 2.3-1.6L8 13.5",
  spark: "M12 3.5 13.7 9l5.8 1.9-5.8 1.9L12 18.5l-1.7-5.7L4.5 11 10.3 9z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 7.5V12l3 2",
  alert: "M12 4 3 19.5h18zM12 10v4.5M12 17.2h.01",
  stop: "M8.5 6h7a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 15.5v-7A2.5 2.5 0 0 1 8.5 6z",
  lock: "M7.5 10.5h9a2.5 2.5 0 0 1 2.5 2.5v4.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17.5V13a2.5 2.5 0 0 1 2.5-2.5zM8 10.5V8a4 4 0 0 1 8 0v2.5",
  help: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2.9-1.2 1.7M12 16.7h.01",
  term: "M6 4.5h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3zM7.5 10l3 2.5-3 2.5M13 15h4",
  branch: "M7 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 16.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 7.5v9M17 11c0 3-4 3-10 5.5",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.2-4.2",
  funnel: "M4 5.5h16l-6 7.5v5l-4 1.5V13z",
  code: "m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z",
  verify: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM8.5 12.3l2.4 2.4 4.6-4.9",
  grid: "M6 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 4h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 14h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2z",
  list: "M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01",
  shield: "M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6zM9 12l2.2 2.2L15.5 10",
  copy: "M10.5 8.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5",
  retry: "M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.5v4h4",
  file: "M7.5 3.5H13.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5zM13.5 3.5V8H18",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  ext: "M13 5h6v6M19 5l-8 8M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5H10",
  folder: "M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  play: "M8 5.5v13l11-6.5z",
  info: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5M12 8h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-[13px]" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={`${className} shrink-0 fill-none stroke-current`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

export const STATE_ICON: Record<RunIcon, IconName> = { hand: "hand", spark: "spark", check: "check", clock: "clock", alert: "alert", stop: "stop", lock: "lock", help: "help" };

export const KIND_ICON: Record<RunKind, IconName> = { investigate: "search", triage: "funnel", build: "code", review: "eye", verify: "verify" };
