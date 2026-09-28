import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "./backend/mock";
import { currentItems, selectedEvent, selectedTicket, useStore } from "./store";

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
});
