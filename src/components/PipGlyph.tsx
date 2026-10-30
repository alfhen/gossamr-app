import { useId } from "react";

/** Pip's mark at text size: a spider on its thread. Takes its colour from the text around it. */
export function PipGlyph({ className = "" }: { className?: string }) {
  const mask = `pip-glyph-eyes-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 16 16" data-pip-glyph aria-hidden="true" className={`inline-block size-[1em] shrink-0 align-[-0.125em] ${className}`}>
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="#fff" />
        <circle cx="6.5" cy="10.2" r=".95" fill="#000" />
        <circle cx="9.5" cy="10.2" r=".95" fill="#000" />
      </mask>
      <path d="M8 0.6V6" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".5" />
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M4.3 9.7 C3 7.5 1.3 7.9 0.9 10" />
        <path d="M4.4 12.4 C2.7 12.1 1.9 13.6 2.3 15.2" />
        <path d="M11.7 9.7 C13 7.5 14.7 7.9 15.1 10" />
        <path d="M11.6 12.4 C13.3 12.1 14.1 13.6 13.7 15.2" />
      </g>
      <circle cx="8" cy="10.9" r="4.4" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}
