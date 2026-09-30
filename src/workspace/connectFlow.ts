import type { ConnectionInfo, DeviceStart, GithubSignInOptions } from "../types";

export type ConnectMethod = "token" | "cli" | "device";

export type DevicePhase = "starting" | "waiting" | "expired" | "denied" | "failed";

export type ConnectState =
  | { step: "choose" }
  | { step: "token"; busy: boolean; error: string | null }
  | { step: "cli"; busy: boolean; error: string | null }
  | { step: "device"; phase: DevicePhase; code: DeviceStart | null; expiresAt: number | null; error: string | null }
  | { step: "connected"; connection: ConnectionInfo };

export type ConnectEvent =
  | { type: "pick"; method: ConnectMethod }
  | { type: "submit" }
  | { type: "fail"; message: string }
  | { type: "connected"; connection: ConnectionInfo }
  | { type: "deviceCode"; code: DeviceStart; now: number }
  | { type: "deviceEnd"; message: string }
  | { type: "retry" }
  | { type: "back" };

export const START: ConnectState = { step: "choose" };

/** How a failed device wait ended, from the reason the backend gives. */
export function deviceOutcome(message: string): "expired" | "denied" | "failed" {
  if (/expired/i.test(message)) return "expired";
  if (/denied|declined/i.test(message)) return "denied";
  return "failed";
}

export function connectReducer(state: ConnectState, event: ConnectEvent): ConnectState {
  switch (event.type) {
    case "pick":
      if (state.step !== "choose") return state;
      return event.method === "device" ? { step: "device", phase: "starting", code: null, expiresAt: null, error: null } : { step: event.method, busy: false, error: null };
    case "submit":
      return (state.step === "token" || state.step === "cli") && !state.busy ? { ...state, busy: true, error: null } : state;
    case "fail":
      if (state.step === "token" || state.step === "cli") return { ...state, busy: false, error: event.message };
      if (state.step === "device") return { ...state, phase: "failed", error: event.message };
      return state;
    case "connected":
      return state.step === "choose" || state.step === "connected" ? state : { step: "connected", connection: event.connection };
    case "deviceCode":
      return state.step === "device" && state.phase === "starting" ? { ...state, phase: "waiting", code: event.code, expiresAt: event.now + event.code.expiresIn * 1000, error: null } : state;
    case "deviceEnd":
      return state.step === "device" && (state.phase === "waiting" || state.phase === "starting") ? { ...state, phase: deviceOutcome(event.message), error: event.message } : state;
    case "retry":
      return state.step === "device" && state.phase !== "waiting" && state.phase !== "starting" ? { step: "device", phase: "starting", code: null, expiresAt: null, error: null } : state;
    case "back":
      return state.step === "token" || state.step === "cli" || state.step === "device" ? START : state;
  }
}

export interface MethodChoice {
  method: ConnectMethod;
  title: string;
  hint: string;
}

/** The ways this build and this Mac can connect, in the order they are offered. A token always works. */
export function availableMethods(options: GithubSignInOptions | null): MethodChoice[] {
  const out: MethodChoice[] = [];
  if (!options || options.token) out.push({ method: "token", title: "Paste a personal access token", hint: "Works everywhere. You create the token on GitHub and paste it here." });
  if (options?.ghCli) out.push({ method: "cli", title: "Use my GitHub CLI login", hint: "Runs gh auth token once, when you click, and uses what it prints." });
  if (options?.deviceFlow) out.push({ method: "device", title: "Sign in with your browser", hint: "GitHub shows a short code; you enter it on github.com." });
  return out;
}

/** `14:32`, counting down; `0:00` once it has run out. */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Splits text into plain parts and addresses, so an address in an error message can be opened from it. */
export function splitLinks(text: string): { text: string; url: boolean }[] {
  return text
    .split(/(https:\/\/[^\s"'<>)]+)/g)
    .filter(Boolean)
    .map((part) => ({ text: part, url: /^https:\/\//.test(part) }));
}
