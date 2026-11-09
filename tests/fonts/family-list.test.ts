import { FontFamilyList } from "../../src/fonts/family-list";
import { FontSourceRegistry, FontSourceUnavailableError, type FontSource } from "../../src/registry/font-source";

const source = (id: string, list: () => Promise<string[]>): FontSource => ({ id, name: id, list, find: async () => null }) as FontSource;
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(sources: FontSource[], now: () => number = Date.now) {
  const fontSources = new FontSourceRegistry();
  for (const s of sources) fontSources.register(s);
  let loaded = 0;
  const list = new FontFamilyList({ fontSources }, () => void loaded++, now);
  return { list, loaded: () => loaded };
}

describe("FontFamilyList", () => {
  test("is null until the sources have listed, then merged, de-duplicated and sorted case-insensitively, with one callback", async () => {
    const { list, loaded } = make([
      source("a", async () => ["zeta", "Alpha", "beta"]),
      source("b", async () => ["Beta", "Gamma"]),
    ]);
    expect(list.get()).toBeNull();
    expect(list.get()).toBeNull();
    await flush();
    expect(list.get()).toEqual(["Alpha", "beta", "Gamma", "zeta"]);
    expect(loaded()).toBe(1);
    list.get();
    await flush();
    expect(loaded()).toBe(1);
  });

  test("an unavailable or failing source is not yet available: no callback, and the next need tries again", async () => {
    let calls = 0;
    let ready = false;
    const { list, loaded } = make([
      source("a", async () => {
        calls++;
        if (!ready) throw new FontSourceUnavailableError();
        return ["Alpha"];
      }),
    ]);
    list.get();
    await flush();
    expect(list.get()).toBeNull();
    await flush();
    expect(loaded()).toBe(0);
    expect(calls).toBe(2);
    ready = true;
    list.get();
    await flush();
    expect(list.get()).toEqual(["Alpha"]);
    expect(loaded()).toBe(1);
  });

  test("asks while a listing is under way do not start another", async () => {
    let calls = 0;
    const { list } = make([source("a", async () => (calls++, ["A"]))]);
    list.get();
    list.get();
    await flush();
    expect(calls).toBe(1);
  });

  test("an empty result is not cached", async () => {
    let calls = 0;
    const { list, loaded } = make([source("a", async () => (calls++, []))]);
    list.get();
    await flush();
    expect(list.get()).toBeNull();
    expect(loaded()).toBe(0);
  });

  test("one source unavailable keeps the other's families; the menu fills in when it lists, one callback per change", async () => {
    let ready = false;
    let bCalls = 0;
    const { list, loaded } = make([
      source("a", async () => ["Alpha"]),
      source("b", async () => {
        bCalls++;
        if (!ready) throw new FontSourceUnavailableError();
        return ["Beta"];
      }),
    ]);
    list.get();
    await flush();
    expect(list.get()).toEqual(["Alpha"]);
    expect(loaded()).toBe(1);
    await flush();
    expect(loaded()).toBe(1);
    ready = true;
    list.get();
    await flush();
    expect(list.get()).toEqual(["Alpha", "Beta"]);
    expect(loaded()).toBe(2);
    const calls = bCalls;
    list.get();
    await flush();
    expect(bCalls).toBe(calls);
  });

  test("a source that keeps throwing is warned about once and asked at most every 30 s; the others still list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = 1000;
    let calls = 0;
    const { list } = make(
      [
        source("bad", async () => {
          calls++;
          throw new Error("boom");
        }),
        source("ok", async () => ["Alpha"]),
      ],
      () => t,
    );
    list.get();
    await flush();
    expect(list.get()).toEqual(["Alpha"]);
    list.get();
    await flush();
    expect(calls).toBe(1);
    t += 30_000;
    list.get();
    await flush();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
