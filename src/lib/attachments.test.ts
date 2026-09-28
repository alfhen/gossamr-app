import { describe, expect, it } from "vitest";
import { filesIn, formatSize, nameFor } from "./attachments";

const at = new Date(2026, 8, 28, 14, 5, 9);

describe("nameFor", () => {
  it("dates pasted images", () => {
    expect(nameFor(new File(["x"], "image.png", { type: "image/png" }), at).name).toBe("Pasted image 2026-09-28 at 14.05.09.png");
    expect(nameFor(new File(["x"], "", { type: "image/jpeg" }), at).name).toBe("Pasted image 2026-09-28 at 14.05.09.jpg");
  });

  it("keeps real file names", () => {
    const f = new File(["x"], "error log.txt", { type: "text/plain" });
    expect(nameFor(f, at)).toBe(f);
  });
});

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

it("formats sizes", () => {
  expect(formatSize(900)).toBe("900 B");
  expect(formatSize(15 * 1024)).toBe("15 KB");
  expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  expect(formatSize(100 * 1024 * 1024)).toBe("100 MB");
});
