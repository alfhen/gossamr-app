import type { Ref } from "react";

/**
 * A card's key line, plus the live region that says the confirm aloud. The region is mounted with the line, empty, and filled only
 * while a confirm is asked: a region that appears in the same render as its text is often not announced. The visible line is not live.
 */
export function KeyHint({ hint, asking, className, hintRef }: { hint: string; asking: boolean; className: string; hintRef?: Ref<HTMLParagraphElement> }) {
  return (
    <>
      <p ref={hintRef} data-key-hint className={className}>
        {hint}
      </p>
      <p aria-live="polite" data-key-live className="sr-only">
        {asking ? hint : ""}
      </p>
    </>
  );
}
