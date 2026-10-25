import { describe, expect, it } from "vitest";
import { filesIn } from "./attachments";

describe("filesIn", () => {
  it("falls back to items when files is empty", () => {
    const shot = new File(["x"], "image.png", { type: "image/png" });
    const data = {
      files: [] as unknown as FileList,
      items: [{ kind: "string", getAsFile: () => null }, { kind: "file", getAsFile: () => shot }] as unknown as DataTransferItemList,
    } as DataTransfer;
    expect(filesIn(data)).toEqual([shot]);
    expect(filesIn(null)).toEqual([]);
  });
});
