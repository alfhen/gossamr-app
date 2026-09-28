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

  describe("stacks", () => {
    const stackEvents = () => s().snap!.events.filter((e) => e.ticketKey === "CA-420" && e.doneAt === null);

    it("folds a ticket's updates into one item and marks them all read when selected", async () => {
      expect(currentItems(s()).filter((i) => i.ticketKey === "CA-420").map((i) => i.id)).toEqual(["s:CA-420"]);
      s().select("s:CA-420");
      await Promise.resolve();
      expect(stackEvents().some((e) => e.unread)).toBe(false);
    });

    it("clears every update in a stack and undoes", async () => {
      s().select("s:CA-420");
      const count = stackEvents().length;
      await s().markDone();
      expect(stackEvents()).toHaveLength(0);
      expect(s().toast?.message).toBe(`Cleared (${count} updates)`);
      s().toast?.undo?.();
      await new Promise((r) => setTimeout(r));
      expect(stackEvents()).toHaveLength(count);
    });

    it("selects the next ticket, not one of its own updates, after clearing an expanded stack", async () => {
      s().select("s:CA-420");
      s().setStackOpen(true);
      await s().markDone();
      expect(s().selectedId).toBe("s:CE-731");
    });

    it("reverts the updates that changed when part of a stack action fails", async () => {
      const backend = s().backend!;
      const real = backend.setDone.bind(backend);
      const failOn = stackEvents()[1].id;
      backend.setDone = (id, done) => (id === failOn ? Promise.reject(new Error("offline")) : real(id, done));
      s().select("s:CA-420");
      await s().markDone();
      await new Promise((r) => setTimeout(r));
      expect(stackEvents()).toHaveLength(4);
      expect(s().error).toContain("offline");
    });

    it("restores each update's previous snooze on undo", async () => {
      s().select("s:CA-420");
      const first = new Date(Date.now() + 3600_000);
      await s().snooze(first);
      s().setView("snoozed");
      s().select("s:CA-420");
      await s().snooze(new Date(Date.now() + 7200_000));
      s().toast?.undo?.();
      await new Promise((r) => setTimeout(r));
      const until = s().snap!.events.filter((e) => e.ticketKey === "CA-420" && e.doneAt === null).map((e) => e.snoozedUntil);
      expect(until.every((u) => u === first.toISOString())).toBe(true);
    });

    it("expands into a stack's updates and collapses back to the stack", () => {
      s().select("s:CA-420");
      s().setStackOpen(true);
      s().move(1);
      expect(selectedEvent(s())?.ticketKey).toBe("CA-420");
      s().setStackOpen(false);
      expect(s().selectedId).toBe("s:CA-420");
      expect(currentItems(s()).some((i) => i.inStack)).toBe(false);
    });
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

  it("rereads a replacement's snapshot when an update arrived while it loaded", async () => {
    const next = new MockBackend();
    const load = next.load.bind(next);
    let calls = 0;
    next.load = async () => {
      calls++;
      const snap = await load();
      if (calls === 1) await next.syncNow();
      return calls === 1 ? { ...snap, events: snap.events.slice(0, -1) } : snap;
    };
    await s().init(next);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(s().snap!.events.some((e) => e.text.startsWith("@Alf the design is final"))).toBe(true);
  });

  it("keeps an update that lands while the reread is still loading", async () => {
    const next = new MockBackend();
    const load = next.load.bind(next);
    let calls = 0;
    let finishReread: () => void = () => {};
    next.load = async () => {
      calls++;
      const snap = await load();
      if (calls === 1) {
        await next.syncNow();
        return snap;
      }
      await new Promise<void>((r) => (finishReread = r));
      return { ...snap, site: "older.example" };
    };
    await s().init(next);
    await next.syncNow();
    finishReread();
    await new Promise((r) => setTimeout(r, 0));
    expect(s().snap!.site).not.toBe("older.example");
  });

  it("refuses a comment when the backend changed during the upload", async () => {
    const uploadedVia = s().backend!;
    await s().init(new MockBackend());
    expect(await s().comment("Here", { via: uploadedVia })).toBe(false);
    expect(s().error).toMatch(/switched Jira accounts/);
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
