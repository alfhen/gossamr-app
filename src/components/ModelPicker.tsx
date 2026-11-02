import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { MODEL_ID_LIMIT, validModelId } from "../lib/models";
import { choiceLabel, type PickerInstance } from "../lib/modelPicker";
import { usePopover } from "../workspace/Popover";
import type { ModelChoice, ModelOption } from "../types";
import { Button } from "./Button";

export interface ModelPickerProps {
  instances: readonly PickerInstance[];
  /** The models each instance offers, by instance id. An instance that can't run is listed without them. */
  models: Readonly<Record<string, readonly ModelOption[]>>;
  value: ModelChoice | null;
  onChange(choice: ModelChoice): void;
  /** Adds an id to the instance's list. A refusal is shown under the field. */
  onAddModel(instanceId: string, model: string): Promise<void>;
  /** Opens Settings › Connections. Without it the last entry is left out. */
  onManage?(): void;
  /** What the trigger says when `value` names no listed instance. */
  empty?: string;
}

const ID_RULE = `Use letters, digits and . _ - [ ], starting with a letter or digit, up to ${MODEL_ID_LIMIT} characters.`;

const items = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"], [data-menu-action]'));

/** A popover list of instances and their models, with Add model… for the chosen instance. */
export function ModelPicker({ instances, models, value, onChange, onAddModel, onManage, empty = "Choose a model" }: ModelPickerProps) {
  const { open, setOpen, root } = usePopover();
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useId();

  useEffect(() => {
    if (open) return;
    setAdding(false);
    setId("");
    setProblem(null);
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"]')?.focus();
  }, [open, root]);
  useEffect(() => {
    if (adding) root.current?.querySelector<HTMLElement>(`#${CSS.escape(field)}`)?.focus();
  }, [adding, field, root]);

  const label = choiceLabel(value, instances, models) ?? empty;

  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key)) return;
    ev.preventDefault();
    const all = items(ev.currentTarget);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = ev.key === "Home" ? 0 : ev.key === "End" ? all.length - 1 : (at + (ev.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
    all[to]?.focus();
  };

  const pick = (instanceId: string, model: string) => {
    setOpen(false);
    if (value?.instanceId === instanceId && value.model === model) return;
    onChange({ instanceId, model, ...(value?.effort ? { effort: value.effort } : {}) });
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const model = id.trim();
    if (!validModelId(model)) return setProblem(ID_RULE);
    if (!value) return;
    setBusy(true);
    try {
      await onAddModel(value.instanceId, model);
      pick(value.instanceId, model);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="relative flex min-w-0" data-model-picker>
      <Button variant="quiet" size="sm" data-popover-trigger aria-haspopup="menu" aria-expanded={open} aria-label={`Pip runs on ${label}`} title="Choose the Claude and model Pip runs on" className="max-w-full -ml-1.5 !px-1.5 text-xs" onClick={() => setOpen(!open)}>
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-ws-ink3">
          ▾
        </span>
      </Button>
      {open && (
        <ModelMenu
          instances={instances}
          models={models}
          value={value}
          onPick={pick}
          onKeyDown={onKeyDown}
          onManage={onManage && (() => (setOpen(false), onManage()))}
          add={{ open: adding, id, busy, problem, field, onStart: () => setAdding(true), onId: (v) => (setId(v), setProblem(null)), onSubmit: submit }}
        />
      )}
    </div>
  );
}

interface AddState {
  open: boolean;
  id: string;
  busy: boolean;
  problem: string | null;
  field: string;
  onStart(): void;
  onId(id: string): void;
  onSubmit(ev: FormEvent): void;
}

export interface ModelMenuProps extends Pick<ModelPickerProps, "instances" | "models" | "value"> {
  onPick(instanceId: string, model: string): void;
  onKeyDown?(ev: KeyboardEvent<HTMLElement>): void;
  onManage?(): void;
  add: AddState;
}

/** The open list: each instance with its models, Add model… under the chosen one, and a way to Settings. */
export function ModelMenu({ instances, models, value, onPick, onKeyDown, onManage, add }: ModelMenuProps) {
  const row = "block w-full rounded-md px-2 py-1 text-left ws-glass-item";
  const selected = "[background:linear-gradient(var(--color-ws-sel),var(--color-ws-sel)),var(--glass-lens)] font-semibold";
  return (
    <div role="menu" aria-label="Pip runs on" onKeyDown={onKeyDown} className="absolute top-full left-0 z-40 mt-1 w-[260px] ws-pop rounded-xl border border-ws-sep2 bg-ws-win p-1.5 text-sm text-ws-ink shadow-ws-pop">
      {instances.map((instance) => {
        const chosen = value?.instanceId === instance.id;
        return (
          <div key={instance.id} role="group" aria-label={instance.name}>
            <div className="flex items-baseline gap-2 px-2 pt-1.5 pb-1 font-semibold text-ws-ink2">
              <span className="truncate">{instance.name}</span>
              {instance.unavailable && <span className="ml-auto shrink-0 font-normal text-ws-ink3">{instance.unavailable}</span>}
            </div>
            {!instance.unavailable &&
              (models[instance.id] ?? []).map((m) => {
                const on = chosen && value?.model === m.id;
                return (
                  <button key={m.id} type="button" role="menuitemradio" aria-checked={on} onClick={() => onPick(instance.id, m.id)} className={`${row} ${on ? selected : ""}`}>
                    {m.label}
                  </button>
                );
              })}
            {chosen && !instance.unavailable && (add.open ? <AddModelForm add={add} /> : (
              <button type="button" role="menuitem" data-menu-action="add-model" onClick={add.onStart} className={row}>
                Add model…
              </button>
            ))}
          </div>
        );
      })}
      {onManage && (
        <div className="mt-1 border-t border-ws-sep2 pt-1">
          <button type="button" role="menuitem" data-menu-action="manage" onClick={onManage} className={row}>
            Add or manage…
          </button>
        </div>
      )}
    </div>
  );
}

function AddModelForm({ add }: { add: AddState }) {
  return (
    <form onSubmit={add.onSubmit} className="grid gap-1 px-2 py-1">
      <label htmlFor={add.field} className="text-ws-ink2">
        Model id
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id={add.field}
          value={add.id}
          disabled={add.busy}
          onChange={(ev) => add.onId(ev.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-ws-sep2 bg-ws-win px-2 py-1 font-mono text-sm font-normal outline-none focus:border-ws-accent"
        />
        <Button type="submit" variant="primary" size="sm" disabled={add.busy || !add.id.trim()}>
          Add
        </Button>
      </div>
      {add.problem && (
        <p role="alert" className="m-0 text-ws-blocked">
          {add.problem}
        </p>
      )}
    </form>
  );
}
