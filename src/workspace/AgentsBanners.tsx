import type { ReactNode } from "react";
import { Icon, type IconName } from "./AgentIcons";

const TONES = {
  bad: { box: "border-ws-blocked/40 bg-ws-blocked-soft", head: "text-ws-blocked" },
} as const;

const BUTTON = "inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-px text-sm leading-normal whitespace-nowrap hover:bg-ws-hover";

function Banner({ icon, title, children, actions }: { icon: IconName; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-[10px] border px-3.5 py-2.5 ${TONES.bad.box}`}>
      <Icon name={icon} className={`mt-px size-[18px] ${TONES.bad.head}`} />
      <div className="min-w-0 flex-1">
        <b className={`block font-semibold ${TONES.bad.head}`}>{title}</b>
        <p className="m-0 mt-px text-ws-ink2">{children}</p>
        {actions && <div className="mt-2 flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
    </div>
  );
}

export interface AgentsBannersProps {
  /** Why the runs could not be read, when they could not. */
  loadError: string | null;
  onRetry(): void;
}

export function AgentsBanners({ loadError, onRetry }: AgentsBannersProps) {
  if (!loadError) return null;
  return (
    <Banner
      icon="alert"
      title="Couldn't load your agents"
      actions={
        <button type="button" onClick={onRetry} className={BUTTON}>
          <Icon name="retry" />
          Retry
        </button>
      }
    >
      <span className="selectable [overflow-wrap:anywhere]">{loadError}</span>
    </Banner>
  );
}
