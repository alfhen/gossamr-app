import { describe, expect, it } from "vitest";
import { followTransparency } from "./prefs";

function fakeRoot() {
  const dataset: DOMStringMap = {};
  return { dataset, removeAttribute: (name: string) => name === "data-transparency" && delete dataset.transparency } as unknown as HTMLElement;
}

function fakeSystem(reduce: boolean) {
  const system = {
    reduce,
    listeners: [] as (() => void)[],
    reduceTransparency: () => Promise.resolve(system.reduce),
    onDisplayChanged: (listener: () => void) => {
      system.listeners.push(listener);
      return () => void system.listeners.splice(system.listeners.indexOf(listener), 1);
    },
  };
  return system;
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("following Reduce transparency", () => {
  it("marks the page when the system reduces transparency and unmarks it when the person turns that off", async () => {
    const root = fakeRoot();
    const system = fakeSystem(true);
    followTransparency(system, root);
    await settle();
    expect(root.dataset.transparency).toBe("reduce");

    system.reduce = false;
    system.listeners.forEach((l) => l());
    await settle();
    expect(root.dataset.transparency).toBeUndefined();
  });

  it("keeps the newest answer when an older one arrives late", async () => {
    const root = fakeRoot();
    const answers: ((reduce: boolean) => void)[] = [];
    const system = { ...fakeSystem(false), reduceTransparency: () => new Promise<boolean>((resolve) => answers.push(resolve)) };
    followTransparency(system, root);
    system.listeners.forEach((l) => l());
    answers[1](true);
    answers[0](false);
    await settle();
    expect(root.dataset.transparency).toBe("reduce");
  });

  it("ignores an answer that arrives after it stops", async () => {
    const root = fakeRoot();
    let answer: (reduce: boolean) => void = () => {};
    const system = { ...fakeSystem(false), reduceTransparency: () => new Promise<boolean>((resolve) => (answer = resolve)) };
    const stop = followTransparency(system, root);
    stop();
    answer(true);
    await settle();
    expect(root.dataset.transparency).toBeUndefined();
  });

  it("stops listening and clears the mark when it stops", async () => {
    const root = fakeRoot();
    const system = fakeSystem(true);
    const stop = followTransparency(system, root);
    await settle();
    stop();
    expect(root.dataset.transparency).toBeUndefined();
    expect(system.listeners).toEqual([]);
  });
});
