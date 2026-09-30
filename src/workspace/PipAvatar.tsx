import { useId } from "react";

/** Pip, the spider. The gradient id is per instance so two avatars on a page don't share one. */
export function PipAvatar({ size = 28 }: { size?: number }) {
  const id = `pip-grad-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="-32 -30 64 64" width={size} height={size} aria-hidden="true" className="shrink-0">
      <defs>
        <radialGradient id={id} cx=".35" cy=".3" r=".9">
          <stop offset="0" stopColor="#b9fbf0" />
          <stop offset=".5" stopColor="#34c6b9" />
          <stop offset="1" stopColor="#5b4bd1" />
        </radialGradient>
      </defs>
      <g fill="none" stroke="#5b4bd1" strokeWidth="2.4" strokeLinecap="round">
        <path d="M-6 -12 Q-19 -26 -28 -15" />
        <path d="M-9 -6 Q-25 -12 -30 1" />
        <path d="M-9 2 Q-25 4 -28 17" />
        <path d="M-6 9 Q-16 17 -21 28" />
        <path d="M6 -12 Q19 -26 28 -15" />
        <path d="M9 -6 Q25 -12 30 1" />
        <path d="M9 2 Q25 4 28 17" />
        <path d="M6 9 Q16 17 21 28" />
      </g>
      <ellipse cx="0" cy="7" rx="13.5" ry="15" fill={`url(#${id})`} />
      <ellipse cx="0" cy="7" rx="5" ry="7" fill="#2a1f7a" opacity=".22" />
      <ellipse cx="-4.5" cy="2" rx="3.6" ry="6" fill="#fff" opacity=".28" />
      <circle cx="0" cy="-10" r="10" fill={`url(#${id})`} />
      <ellipse cx="-4" cy="-15" rx="4" ry="2.2" fill="#fff" opacity=".45" />
      <circle cx="-4.3" cy="-11" r="3.6" fill="#fff" />
      <circle cx="4.3" cy="-11" r="3.6" fill="#fff" />
      <circle cx="-4.3" cy="-11" r="1.8" fill="#14131d" />
      <circle cx="4.3" cy="-11" r="1.8" fill="#14131d" />
      <circle cx="-1.8" cy="-5.6" r="1" fill="#14131d" opacity=".8" />
      <circle cx="1.8" cy="-5.6" r="1" fill="#14131d" opacity=".8" />
    </svg>
  );
}
