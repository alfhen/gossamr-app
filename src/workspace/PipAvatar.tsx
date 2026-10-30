import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { pupilOffset, watchGaze } from "./pipGaze";

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const pageHidden = () => document.hidden;

interface Props {
  size?: number;
  /** Legs scuttle and the body bobs while Pip is working on an answer. */
  thinking?: boolean;
  /** Hangs from a thread, swaying gently; the launcher does, the pane header sits still. */
  dangle?: boolean;
}

/** Pip, the spider. Blinks, twitches a leg and follows the pointer with its eyes; all of it stops for reduced motion and while the page is hidden. The gradient ids are per instance so two avatars on a page don't share one. */
export function PipAvatar({ size = 28, thinking = false, dangle = false }: Props) {
  const uid = useId().replace(/:/g, "");
  const id = `pip-grad-${uid}`;
  const rim = `pip-rim-${uid}`;
  const svg = useRef<SVGSVGElement>(null);
  const hidden = useSyncExternalStore(subscribeVisibility, pageHidden, () => false);

  useEffect(
    () =>
      watchGaze((target) => {
        const el = svg.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const { x, y } = pupilOffset({ x: r.left + r.width / 2, y: r.top + r.height * 0.4 }, target);
        el.querySelectorAll<SVGElement>(".pip-pup").forEach((p) => (p.style.transform = `translate(${x}px,${y}px)`));
      }),
    [],
  );

  return (
    <svg
      ref={svg}
      data-pip-avatar
      data-thinking={thinking ? "" : undefined}
      data-paused={hidden ? "" : undefined}
      viewBox="-32 -30 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      className={`pip-av shrink-0 ${dangle ? "pip-dangle" : ""}`}
    >
      <defs>
        <radialGradient id={id} cx=".38" cy=".3" r=".85">
          <stop offset="0" stopColor="#d6f5ef" />
          <stop offset=".55" stopColor="#4fb9b4" />
          <stop offset="1" stopColor="#5f54b8" />
        </radialGradient>
        <linearGradient id={rim} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".35" />
        </linearGradient>
      </defs>
      <g className="pip-body">
        <g className="pip-legs" fill="none" strokeWidth="2" strokeLinecap="round">
          <path d="M-6 -12 Q-19 -26 -28 -15" />
          <path d="M-9 -6 Q-25 -12 -30 1" />
          <path d="M-9 2 Q-25 4 -28 17" />
          <path d="M-6 9 Q-16 17 -21 28" />
          <path d="M6 -12 Q19 -26 28 -15" />
          <path d="M9 -6 Q25 -12 30 1" />
          <path d="M9 2 Q25 4 28 17" />
          <path d="M6 9 Q16 17 21 28" />
        </g>
        <ellipse cx="0" cy="7" rx="13" ry="14.5" fill={`url(#${id})`} />
        <ellipse cx="1.5" cy="14.6" rx="6.5" ry="3.2" fill="#fff" opacity=".24" />
        <ellipse cx="-5" cy="1" rx="2.8" ry="4.6" fill="#fff" opacity=".62" transform="rotate(-18 -5 1)" />
        <ellipse cx="0" cy="7" rx="12.6" ry="14.1" fill="none" stroke={`url(#${rim})`} strokeWidth=".9" />
        <circle cx="0" cy="-10" r="9.5" fill={`url(#${id})`} />
        <ellipse cx="-3.8" cy="-15.2" rx="3.2" ry="1.7" fill="#fff" opacity=".6" />
        <circle cx="0" cy="-10" r="9.1" fill="none" stroke={`url(#${rim})`} strokeWidth=".8" />
        <g className="pip-lids">
          <circle cx="-4.2" cy="-11" r="3.9" fill="#fff" />
          <circle cx="4.2" cy="-11" r="3.9" fill="#fff" />
          <g className="pip-pup">
            <circle cx="-4.2" cy="-11" r="2" fill="#14131d" />
            <circle cx="-3.5" cy="-11.8" r=".65" fill="#fff" />
          </g>
          <g className="pip-pup">
            <circle cx="4.2" cy="-11" r="2" fill="#14131d" />
            <circle cx="4.9" cy="-11.8" r=".65" fill="#fff" />
          </g>
        </g>
        <path d="M-2.2 -5.4 Q0 -3.7 2.2 -5.4" fill="none" stroke="#14131d" strokeWidth=".9" strokeLinecap="round" opacity=".7" />
      </g>
    </svg>
  );
}
