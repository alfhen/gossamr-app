import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { ItemRef } from "../types";
import { useDev } from "./devStore";

const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });
const settle = () => new Promise((r) => setTimeout(r, 120));

async function connected() {
  const backend = new MockBackend({ githubRepos: 10 });
  useDev.getState().init(backend);
  useDev.getState().setEnabled(true);
  return backend;
}

afterEach(() => useDev.getState().dispose());

describe("the development index", () => {
  it("reads the links of the items it is asked for and summarises them", async () => {
    await connected();
    useDev.getState().ensure([ref("CA-208"), ref("CA-999")]);
    await settle();
    const { index, byChange } = useDev.getState();
    expect(index.get("mock:CA-208")).toMatchObject({ prs: 1, commits: 1, state: "draft", failing: true });
    expect(index.get("mock:CA-999")).toMatchObject({ prs: 0 });
    expect(byChange.get("pr:acme/webshop#208")).toEqual(ref("CA-208"));
  });

  it("never has more than four reads in flight and reads each item once", async () => {
    const backend = await connected();
    let flying = 0;
    let peak = 0;
    const calls: string[] = [];
    const real = backend.devLinks.bind(backend);
    vi.spyOn(backend, "devLinks").mockImplementation(async (item) => {
      calls.push(item.key);
      flying++;
      peak = Math.max(peak, flying);
      await new Promise((r) => setTimeout(r, 5));
      flying--;
      return real(item);
    });
    const many = Array.from({ length: 30 }, (_, i) => ref(`CA-${i}`));
    useDev.getState().ensure(many);
    useDev.getState().ensure(many);
    await new Promise((r) => setTimeout(r, 300));
    expect(peak).toBeLessThanOrEqual(4);
    expect(calls).toHaveLength(30);
    expect(useDev.getState().index.size).toBe(30);
  });

  it("keeps the cap and reads a key once when links change while reads are in flight", async () => {
    const backend = await connected();
    let flying = 0;
    let peak = 0;
    const calls = new Map<string, number>();
    const real = backend.devLinks.bind(backend);
    vi.spyOn(backend, "devLinks").mockImplementation(async (item) => {
      calls.set(item.key, (calls.get(item.key) ?? 0) + 1);
      flying++;
      peak = Math.max(peak, flying);
      await new Promise((r) => setTimeout(r, 20));
      flying--;
      return real(item);
    });
    useDev.getState().ensure(Array.from({ length: 12 }, (_, i) => ref(`CA-${i}`)));
    await new Promise((r) => setTimeout(r, 5));
    useDev.getState().invalidate();
    useDev.getState().invalidate();
    await new Promise((r) => setTimeout(r, 500));
    expect(peak).toBeLessThanOrEqual(4);
    expect(Math.max(...calls.values())).toBeLessThanOrEqual(2);
    expect(useDev.getState().index.size).toBe(12);
  });

  it("reads nothing while no code host is connected, and forgets everything when it goes", async () => {
    const backend = new MockBackend();
    const spy = vi.spyOn(backend, "devLinks");
    useDev.getState().init(backend);
    useDev.getState().ensure([ref("CA-208")]);
    await settle();
    expect(spy).not.toHaveBeenCalled();
    useDev.getState().setEnabled(true);
    await settle();
    expect(useDev.getState().index.size).toBe(1);
    useDev.getState().setEnabled(false);
    expect(useDev.getState().index.size).toBe(0);
  });

  it("reads again what it had when links change", async () => {
    const backend = await connected();
    useDev.getState().ensure([ref("CA-209")]);
    await settle();
    expect(useDev.getState().index.get("mock:CA-209")?.branches).toBe(0);
    await backend.devLinksLive(ref("CA-209"));
    await settle();
    expect(useDev.getState().index.get("mock:CA-209")?.branches).toBe(1);
  });
});
