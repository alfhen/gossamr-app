import { footerHints, RANK_CLASS } from "./footerHints";
import type { ViewMode } from "./tabsStore";

const KBD = "font-sans text-[11px] rounded border border-ws-sep2 bg-ws-bar px-1";

/** One line, left-aligned; what does not fit is dropped lowest-priority first and the rest is ellipsised. */
export function ShortcutHint({ view }: { view: ViewMode }) {
  const hints = footerHints(view);
  return (
    <p className="m-0 min-w-0 flex-1 truncate">
      {hints.map((h, at) => (
        <span key={h.id} className={RANK_CLASS[h.rank]}>
          {at > 0 && (h.keys.length ? " · " : " ")}
          {h.keys.map((k, i) => (
            <span key={k}>
              {i > 0 && " "}
              <kbd className={KBD}>{k}</kbd>
            </span>
          ))}
          {h.keys.length > 0 && " "}
          {h.text}
        </span>
      ))}
    </p>
  );
}
