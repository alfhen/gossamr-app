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

/** Pip, the spider. Blinks, twitches a leg and follows the pointer with its eyes; all of it stops for reduced motion and while the page is hidden. The gradient id is per instance so two avatars on a page don't share one. */
export function PipAvatar({ size = 28, thinking = false, dangle = false }: Props) {
  const id = `pip-grad-${useId().replace(/:/g, "")}`;
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
        <radialGradient id={id} cx=".35" cy=".3" r=".9">
          <stop offset="0" stopColor="#b9fbf0" />
          <stop offset=".5" stopColor="#34c6b9" />
          <stop offset="1" stopColor="#5b4bd1" />
        </radialGradient>
      </defs>
      <g className="pip-legs" fill="none" strokeWidth="2.4" strokeLinecap="round">
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
      <g className="pip-lids">
        <circle cx="-4.3" cy="-11" r="3.6" fill="#fff" />
        <circle cx="4.3" cy="-11" r="3.6" fill="#fff" />
        <circle className="pip-pup" cx="-4.3" cy="-11" r="1.8" fill="#14131d" />
        <circle className="pip-pup" cx="4.3" cy="-11" r="1.8" fill="#14131d" />
      </g>
      <circle cx="-1.8" cy="-5.6" r="1" fill="#14131d" opacity=".8" />
      <circle cx="1.8" cy="-5.6" r="1" fill="#14131d" opacity=".8" />
    </svg>
  );
}
