const P = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" strokeLinecap="round" />
    </>
  ),
  pause: (
    <>
      <rect x="3.75" y="2.75" width="3" height="10.5" rx="1" className="fill-ws-warn/35" />
      <rect x="9.25" y="2.75" width="3" height="10.5" rx="1" className="fill-ws-warn/35" />
    </>
  ),
  chevron: <path d="M4.5 6.5 8 10l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />,
};

export type IconName = keyof typeof P;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      {P[name]}
    </svg>
  );
}
