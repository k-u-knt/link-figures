import { zip } from "../../src/export/zip";
import { unzip } from "./pptx/ooxml";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("zip", () => {
  it("writes entries that node's zlib reads back, in order, with their CRCs", () => {
    const big = text("hello ".repeat(1000));
    const bytes = zip([
      { name: "a.txt", data: text("first") },
      { name: "dir/b.xml", data: big },
      { name: "c.bin", data: new Uint8Array([0, 1, 2, 255]), store: true },
    ]);
    const entries = unzip(bytes);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.xml", "c.bin"]);
    expect(new TextDecoder().decode(entries[0].data)).toBe("first");
    expect(entries[1].data).toEqual(big);
    expect(entries[1].method).toBe(8);
    expect(entries[2].method).toBe(0);
    expect([...entries[2].data]).toEqual([0, 1, 2, 255]);
    // Deflate pays off on repetitive text.
    expect(bytes.byteLength).toBeLessThan(big.byteLength);
  });

  it("stores an entry that deflate would not make smaller", () => {
    const noise = new Uint8Array(64).map((_, i) => (i * 97 + 13) & 0xff);
    const [entry] = unzip(zip([{ name: "n", data: noise }]));
    expect(entry.method).toBe(0);
    expect(entry.data).toEqual(noise);
  });

  it("writes empty entries and an empty archive", () => {
    expect(unzip(zip([]))).toEqual([]);
    const [entry] = unzip(zip([{ name: "empty", data: new Uint8Array(0) }]));
    expect(entry.data.byteLength).toBe(0);
  });

  it("marks a non-ASCII name as UTF-8", () => {
    const bytes = zip([{ name: "ppt/média.png", data: text("x") }]);
    expect(unzip(bytes)[0].name).toBe("ppt/média.png");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it("is the same bytes each time (a fixed timestamp)", () => {
    const entries = [{ name: "a", data: text("abc") }];
    expect(zip(entries)).toEqual(zip(entries));
  });

  it("refuses a repeated name", () => {
    expect(() => zip([{ name: "a", data: text("1") }, { name: "a", data: text("2") }])).toThrow(/a/);
  });
});
