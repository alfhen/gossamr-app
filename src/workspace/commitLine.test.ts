import { describe, expect, it } from "vitest";
import { commitLine } from "./commitLine";

describe("the line a run shows about who commits", () => {
  it("names the address and the account that pushes", () => {
    expect(commitLine({ commitEmail: "alf@acme.example" }, "alfhen")).toBe("Commits as alf@acme.example · pushes as alfhen");
  });

  it("leaves out the account when gh has none, and says nothing before the clone was read", () => {
    expect(commitLine({ commitEmail: "alf@acme.example" }, null)).toBe("Commits as alf@acme.example");
    expect(commitLine({ commitEmail: null }, "alfhen")).toBeNull();
    expect(commitLine({}, "alfhen")).toBeNull();
  });
});
