import type { FooterHint } from "../lib/keys";

export type { FooterHint };

/** Container-query classes that drop a hint once the footer is narrower than its rank allows. */
export const RANK_CLASS = ["", "hidden @md:inline", "hidden @xl:inline", "hidden @3xl:inline"] as const;
