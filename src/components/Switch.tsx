import { useId, type ReactNode } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange(on: boolean): void;
  disabled?: boolean;
  pending?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export function Switch({ checked, onChange, disabled = false, pending = false, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      onClick={() => onChange(!checked)}
      {...aria}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-accent disabled:cursor-default ${
        checked ? "bg-ws-accent hover:brightness-110" : "bg-ws-ink3/35 hover:bg-ws-ink3/50"
      } ${disabled && !pending ? "opacity-45" : ""}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none grid size-4 place-items-center rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none ${checked ? "translate-x-[18px]" : "translate-x-0.5"} ${
          pending ? "opacity-80" : ""
        }`}
      >
        {pending && <span data-spinner className="size-2.5 animate-spin rounded-full border-[1.5px] border-ws-accent border-t-transparent motion-reduce:animate-none" />}
      </span>
    </button>
  );
}

export interface SwitchRowProps extends Omit<SwitchProps, "id" | "aria-label" | "aria-labelledby" | "aria-describedby"> {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

export function SwitchRow({ label, description, className = "", ...switchProps }: SwitchRowProps) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const descId = description ? `${uid}-desc` : undefined;
  const inactive = switchProps.disabled || switchProps.pending;
  return (
    <label className={`flex items-start justify-between gap-4 ${inactive ? "cursor-default" : "cursor-pointer"} ${className}`}>
      <span className="min-w-0">
        <span id={labelId} className="font-semibold">
          {label}
        </span>
        {description && (
          <span id={descId} className="block text-ws-ink3">
            {description}
          </span>
        )}
      </span>
      <Switch {...switchProps} aria-labelledby={labelId} aria-describedby={descId} />
    </label>
  );
}
