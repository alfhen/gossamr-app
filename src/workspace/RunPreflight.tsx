import type { Preflight, PreflightRow } from "../types";
import { Icon, type IconName } from "./AgentIcons";
import { Box } from "./AgentSheet";

const LOOK: Record<PreflightRow["level"], { icon: IconName; tone: string; word: string }> = {
  green: { icon: "check", tone: "text-ws-done", word: "Fine" },
  amber: { icon: "alert", tone: "text-ws-warn", word: "Look at this" },
  red: { icon: "x", tone: "text-ws-blocked", word: "Blocks starting" },
};

/** The checks before approving. Colour is never the only signal: each row has an icon and a word for screen readers. */
export function RunPreflight({ preflight, checking }: { preflight: Preflight | null; checking: boolean }) {
  if (!preflight) {
    return (
      <p role="status" className="m-0 text-ws-ink3">
        {checking ? "Checking that it can start…" : "The checks couldn't be made, so Start stays off."}
      </p>
    );
  }
  return (
    <Box label="Checks before you approve">
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {preflight.rows.map((row, i) => {
          const look = LOOK[row.level];
          return (
            <li key={i} data-level={row.level} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-ws-ink2">
              <Icon name={look.icon} className={`mt-0.5 size-[15px] ${look.tone}`} />
              <span className="[overflow-wrap:anywhere]">
                <span className="sr-only">{look.word}: </span>
                {row.text}
              </span>
            </li>
          );
        })}
      </ul>
    </Box>
  );
}
