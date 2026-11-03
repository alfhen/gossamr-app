import type { FormEvent } from "react";
import { Button } from "./Button";

interface AddModelFieldProps {
  field: string;
  value: string;
  busy: boolean;
  problem: string | null;
  autoFocus?: boolean;
  onChange(id: string): void;
  onSubmit(ev: FormEvent): void;
  onCancel?(): void;
}

/** The model id input with its Add button, and Cancel when `onCancel` is given. */
export function AddModelField({ field, value, busy, problem, autoFocus, onChange, onSubmit, onCancel }: AddModelFieldProps) {
  return (
    <form onSubmit={onSubmit} className="grid gap-1 px-2 py-1">
      <label htmlFor={field} className="text-sm text-ws-ink2">
        Model id
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={field}
          value={value}
          disabled={busy}
          autoFocus={autoFocus}
          onChange={(ev) => onChange(ev.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-ws-sep2 bg-ws-win px-2 py-1 font-mono text-sm font-normal outline-none focus:border-ws-accent"
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !value.trim()}>
          Add
        </Button>
        {onCancel && (
          <Button variant="quiet" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {problem && (
        <p role="alert" className="m-0 text-sm text-ws-blocked">
          {problem}
        </p>
      )}
    </form>
  );
}
