import { create } from "zustand";

export type ToastTone = "error" | "info";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run(): void;
}

interface ToastState {
  toasts: Toast[];
  push(text: string, tone?: ToastTone, action?: ToastAction): void;
  dismiss(id: number): void;
  clear(): void;
}

const LIFETIME_MS = 9000;
const MAX_SHOWN = 4;
let seq = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],

  push(text, tone = "error", action) {
    if (get().toasts.some((t) => t.text === text)) return;
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone, action }].slice(-MAX_SHOWN) }));
    setTimeout(() => get().dismiss(id), LIFETIME_MS);
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));
