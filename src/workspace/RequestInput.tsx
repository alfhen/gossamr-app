import type { PermissionKind } from "../types";
import { inputFields, type Seg } from "./permissionInput";

/** Text as React text, never HTML or Markdown; a character a terminal would hide is a marked placeholder. */
function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((seg, i) =>
        "hidden" in seg ? (
          <span key={i} data-hidden-char role="img" aria-label={seg.label} className="rounded border border-ws-warn px-0.5 text-ws-warn">
            {seg.hidden}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** Lines in each stretch the item watches to know a long request was scrolled through, not jumped over. */
const STRETCH = 40;

/** Lines as lines, each with its own mark in front when it is removed (−) or added (+), in stretches of `STRETCH`. */
function Lines({ lines, mark, tone = "" }: { lines: Seg[][]; mark?: "−" | "+"; tone?: string }) {
  const stretches = Array.from({ length: Math.ceil(lines.length / STRETCH) }, (_, i) => lines.slice(i * STRETCH, (i + 1) * STRETCH));
  return (
    <>
      {stretches.map((stretch, s) => (
        <div key={s} data-seen-part>
          {stretch.map((line, i) => (
            <div key={i} data-line={mark ?? ""} className={`min-h-[1lh] ${tone}`}>
              {mark && (
                <span aria-hidden className="select-none pr-1">
                  {mark}
                </span>
              )}
              <Segs segs={line} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * The whole input a request would pass the agent, every field by its name, so nothing an Allow gives is out of sight: no
 * hover, no click, no cut, no scrolling in its own box.
 */
export function RequestInput({ kind, input }: { kind: PermissionKind; input: unknown }) {
  const fields = inputFields(kind, input);
  if (!fields.length) return null;
  return (
    // No height cap: a box that scrolled could keep the end of a command out of sight while Allow is in reach.
    <dl data-request-input className="selectable m-0 grid gap-2 rounded-md border border-ws-sep bg-ws-bar px-2.5 py-1.5">
      {fields.map((field, i) => (
        <div key={i} data-input-field className="grid gap-0.5">
          <dt className="font-mono text-xs text-ws-ink3">
            <Segs segs={field.name} />
          </dt>
          <dd className="m-0 font-mono text-sm break-words whitespace-pre-wrap text-ws-ink [tab-size:4]">
            {field.type === "text" ? (
              <Lines lines={field.lines} />
            ) : (
              <>
                <Lines lines={field.removed} mark="−" tone="text-ws-blocked" />
                <Lines lines={field.added} mark="+" tone="text-ws-done" />
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
