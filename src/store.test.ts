import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "./backend/mock";
import { currentItems, selectedEvent, selectedTicket, useStore } from "./store";
import type { Snapshot } from "./types";

const initial = useStore.getState();

beforeEach(async () => {
  useStore.setState(initial, true);
  await useStore.getState().init(new MockBackend());
});

const s = () => useStore.getState();

describe("store", () => {
  it("selects the newest inbox item on load and marks it read", () => {
    const ev = selectedEvent(s());
    expect(ev?.ticketKey).toBe("CA-418");
    expect(ev?.unread).toBe(false);
  });

  it("moves through the list and stops at the ends", () => {
    s().move(-1);
    expect(selectedEvent(s())?.ticketKey).toBe("CA-418");
    s().move(1);
    expect(selectedEvent(s())?.ticketKey).toBe("CA-412");
  });

  it("marks done, selects the next item, and undoes", async () => {
    const id = selectedEvent(s())!.id;
    await s().markDone();
    expect(currentItems(s()).some((i) => i.event?.id === id)).toBe(false);
    expect(selectedEvent(s())?.ticketKey).toBe("CA-412");
    s().toast?.undo?.();
    await Promise.resolve();
    expect(currentItems(s()).some((i) => i.event?.id === id)).toBe(true);
  });

  it("keeps the change summary while a ticket is open and clears it after leaving", async () => {
    expect(selectedTicket(s())?.changes).toHaveLength(1);
    s().move(1);
    await Promise.resolve();
    expect(s().snap!.tickets["CA-418"].changes).toHaveLength(0);
    expect(selectedTicket(s())?.changes).toHaveLength(1);
  });

  it("transitions the selected ticket", async () => {
    const [unblock] = await s().backend!.transitions("CA-418");
    await s().transition(unblock.id, unblock.name);
    expect(s().snap!.tickets["CA-418"].status.name).toBe("In Progress");
  });

  it("does not post an empty comment", async () => {
    const before = selectedTicket(s())!.comments.length;
    expect(await s().comment("   ")).toBe(false);
    expect(await s().comment("On it")).toBe(true);
    expect(selectedTicket(s())!.comments).toHaveLength(before + 1);
  });

  it("opens a ticket that is not in the current view", () => {
    s().goToTicket("CE-731");
    expect(s().view).toBe("inbox");
    s().setView("mentions");
    s().goToTicket("CA-412");
    expect(s().view).toBe("mine");
    expect(selectedTicket(s())?.key).toBe("CA-412");
  });

  it("does not open the transition menu without a selected ticket", () => {
    s().select(null);
    s().openOverlay("transition");
    expect(s().overlay).toBeNull();
  });

  it("puts a snoozed item back in Snoozed when marking it done is undone", async () => {
    const until = new Date(Date.now() + 3600_000);
    await s().snooze(until);
    s().setView("snoozed");
    const id = selectedEvent(s())!.id;
    await s().markDone();
    s().toast?.undo?.();
    await new Promise((r) => setTimeout(r, 0));
    const ev = s().snap!.events.find((e) => e.id === id)!;
    expect(ev.doneAt).toBeNull();
    expect(ev.snoozedUntil).toBe(until.toISOString());
  });

  it("ignores a load that finishes after a newer init", async () => {
    let finishSlow: (snap: Snapshot) => void = () => {};
    const slow = new MockBackend();
    slow.load = () => new Promise((resolve) => (finishSlow = resolve));
    const slowInit = s().init(slow);
    const fresh = new MockBackend();
    await s().init(fresh);
    const staleSnap = { ...s().snap!, site: "stale.example" };
    finishSlow(staleSnap);
    await slowInit;
    expect(s().backend).toBe(fresh);
    expect(s().snap!.site).not.toBe("stale.example");
  });

  it("keeps the current backend working when a new one fails to load", async () => {
    const current = s().backend!;
    let disposed = false;
    current.dispose = () => void (disposed = true);
    const broken = new MockBackend();
    broken.load = () => Promise.reject(new Error("offline"));
    await expect(s().init(broken)).rejects.toThrow("offline");
    expect(s().backend).toBe(current);
    expect(disposed).toBe(false);
    await current.syncNow();
    expect(s().snap!.events.some((e) => e.text.startsWith("@Alf the design is final"))).toBe(true);
  });
});
