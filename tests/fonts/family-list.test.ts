import { FontFamilyList } from "../../src/fonts/family-list";
import { FontSourceRegistry, FontSourceUnavailableError, type FontSource } from "../../src/registry/font-source";

const source = (id: string, list: () => Promise<string[]>): FontSource => ({ id, name: id, list, find: async () => null }) as FontSource;
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(...sources: FontSource[]) {
  const fontSources = new FontSourceRegistry();
  for (const s of sources) fontSources.register(s);
  let loaded = 0;
  const list = new FontFamilyList({ fontSources }, () => void loaded++);
  return { list, loaded: () => loaded };
}

describe("FontFamilyList", () => {
  test("is null until the sources have listed, then merged, de-duplicated and sorted case-insensitively, with one callback", async () => {
    const { list, loaded } = make(
      source("a", async () => ["zeta", "Alpha", "beta"]),
      source("b", async () => ["Beta", "Gamma"]),
    );
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
    const { list, loaded } = make(
      source("a", async () => {
        calls++;
        if (!ready) throw new FontSourceUnavailableError();
        return ["Alpha"];
      }),
    );
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
    const { list } = make(source("a", async () => (calls++, ["A"])));
    list.get();
    list.get();
    await flush();
    expect(calls).toBe(1);
  });

  test("an empty result is not cached", async () => {
    let calls = 0;
    const { list, loaded } = make(source("a", async () => (calls++, [])));
    list.get();
    await flush();
    expect(list.get()).toBeNull();
    expect(loaded()).toBe(0);
  });
});
