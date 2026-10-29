import { footerHints, type FooterOn } from "../lib/keys";
import { RANK_CLASS } from "./footerHints";

const KBD = "font-sans text-[11px] rounded border border-ws-sep2 bg-ws-bar px-1";

/** One line, left-aligned, from the shortcut table; what does not fit is dropped lowest-priority first and the rest is ellipsised. */
export function ShortcutHint({ on }: { on: FooterOn }) {
  const hints = footerHints(on);
  return (
    <p className="m-0 min-w-0 flex-1 truncate">
      {hints.map((h, at) => (
        <span key={h.id} className={RANK_CLASS[h.rank]}>
          {at > 0 && " · "}
          {h.keys.map((k, i) => (
            <span key={k}>
              {i > 0 && " "}
              <kbd className={KBD}>{k}</kbd>
            </span>
          ))}{" "}
          {h.text}
        </span>
      ))}
    </p>
  );
}
