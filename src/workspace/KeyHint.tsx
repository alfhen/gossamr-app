import type { Ref } from "react";

/**
 * A card's key line, plus the live region that says the confirm aloud. The region is always mounted, empty, and filled only while a
 * confirm is asked: a region that appears in the same render as its text is often not announced. The visible line is not live, and is
 * left out while there is no hint, so the region stays the same node as the line comes and goes.
 */
export function KeyHint({ hint, asking, className, hintRef }: { hint: string; asking: boolean; className: string; hintRef?: Ref<HTMLParagraphElement> }) {
  return (
    <>
      {hint && (
        <p ref={hintRef} data-key-hint className={className}>
          {hint}
        </p>
      )}
      <p aria-live="polite" data-key-live className="sr-only">
        {asking ? hint : ""}
      </p>
    </>
  );
}
