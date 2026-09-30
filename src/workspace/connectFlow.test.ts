import { describe, expect, it } from "vitest";
import type { ConnectionInfo, DeviceStart } from "../types";
import { availableMethods, connectReducer, countdown, deviceOutcome, splitLinks, START, type ConnectEvent, type ConnectState } from "./connectFlow";

const code: DeviceStart = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 };
const info = { id: "github:ada", kind: "github", workspace: "ada" } as ConnectionInfo;
const run = (events: ConnectEvent[], from: ConnectState = START) => events.reduce(connectReducer, from);

describe("which ways to connect are offered", () => {
  it("always offers a token, the CLI only when installed and the browser only when configured", () => {
    expect(availableMethods({ token: true, ghCli: false, deviceFlow: false }).map((m) => m.method)).toEqual(["token"]);
    expect(availableMethods({ token: true, ghCli: true, deviceFlow: true }).map((m) => m.method)).toEqual(["token", "cli", "device"]);
    expect(availableMethods(null).map((m) => m.method)).toEqual(["token"]);
    expect(availableMethods({ token: true, ghCli: true, deviceFlow: false }).find((m) => m.method === "cli")?.hint).toMatch(/once/);
  });
});

describe("the connect flow", () => {
  it("connects with a token, keeping the error and the chance to try again", () => {
    let s = run([{ type: "pick", method: "token" }, { type: "submit" }]);
    expect(s).toEqual({ step: "token", busy: true, error: null });
    expect(run([{ type: "submit" }], s)).toBe(s);
    s = run([{ type: "fail", message: "authorise the token for acme" }], s);
    expect(s).toEqual({ step: "token", busy: false, error: "authorise the token for acme" });
    s = run([{ type: "submit" }, { type: "connected", connection: info }], s);
    expect(s).toEqual({ step: "connected", connection: info });
  });

  it("imports the CLI login in one step and can go back", () => {
    expect(run([{ type: "pick", method: "cli" }, { type: "submit" }, { type: "connected", connection: info }]).step).toBe("connected");
    expect(run([{ type: "pick", method: "cli" }, { type: "back" }])).toEqual(START);
    expect(run([{ type: "back" }])).toEqual(START);
  });

  it("waits for the device code, then connects", () => {
    let s = run([{ type: "pick", method: "device" }]);
    expect(s).toMatchObject({ step: "device", phase: "starting", code: null });
    s = run([{ type: "deviceCode", code, now: 1000 }], s);
    expect(s).toMatchObject({ phase: "waiting", code, expiresAt: 1000 + 900_000 });
    expect(run([{ type: "connected", connection: info }], s).step).toBe("connected");
  });

  it("ends as expired, denied or failed, and starts again from any of them", () => {
    const waiting = run([{ type: "pick", method: "device" }, { type: "deviceCode", code, now: 0 }]);
    expect(run([{ type: "deviceEnd", message: "the code expired before it was entered; start again" }], waiting)).toMatchObject({ phase: "expired" });
    expect(run([{ type: "deviceEnd", message: "access_denied" }], waiting)).toMatchObject({ phase: "denied" });
    const failed = run([{ type: "deviceEnd", message: "network down" }], waiting);
    expect(failed).toMatchObject({ phase: "failed", error: "network down" });
    expect(run([{ type: "retry" }], failed)).toMatchObject({ phase: "starting", code: null, error: null });
    expect(run([{ type: "retry" }], waiting)).toBe(waiting);
    expect(run([{ type: "fail", message: "no client id" }, { type: "retry" }], run([{ type: "pick", method: "device" }]))).toMatchObject({ phase: "starting" });
  });

  it("ignores events that don't belong to the step it is on", () => {
    expect(run([{ type: "submit" }, { type: "deviceCode", code, now: 0 }, { type: "deviceEnd", message: "x" }, { type: "connected", connection: info }])).toEqual(START);
  });

  it("classifies how a device wait ended, counts down, and finds addresses in a message", () => {
    expect(deviceOutcome("The device code has expired")).toBe("expired");
    expect(deviceOutcome("access_denied")).toBe("denied");
    expect(deviceOutcome("boom")).toBe("failed");
    expect(countdown(900_000, 0)).toBe("15:00");
    expect(countdown(65_000, 4_000)).toBe("1:01");
    expect(countdown(10, 5000)).toBe("0:00");
    expect(splitLinks("authorise at https://github.com/orgs/acme/sso?x=1 first")).toEqual([
      { text: "authorise at ", url: false },
      { text: "https://github.com/orgs/acme/sso?x=1", url: true },
      { text: " first", url: false },
    ]);
  });
});
