import type { InputHTMLAttributes } from "react";
import { Icon } from "./icons";

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value" | "className"> {
  value: string;
  onChange(value: string): void;
  className?: string;
}

/** A glass capsule for finding things in a list. The boxes you write in stay solid wells. */
export function SearchField({ value, onChange, className = "", ...input }: SearchFieldProps) {
  return (
    <label className={`ws-search ${className}`}>
      <Icon name="search" className="size-[13px] shrink-0" />
      <input {...input} type="search" value={value} onChange={(ev) => onChange(ev.target.value)} />
    </label>
  );
}
