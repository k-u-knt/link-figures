import { describe, expect, it } from "vitest";
import { builtinLuts } from "../../src/adjust/luts";
import { LutRegistry, type Lut } from "../../src/registry/lut";

function lut(id: string): Lut {
  const found = builtinLuts.find((l) => l.id === id);
  if (!found) throw new Error(`no built-in LUT ${id}`);
  return found;
}

function at(id: string, i: number): number[] {
  const table = lut(id).table();
  return [table[i * 3], table[i * 3 + 1], table[i * 3 + 2]];
}

describe("built-in LUTs", () => {
  it("are the ten built-ins, in order", () => {
    expect(builtinLuts.map((l) => l.id)).toEqual(["grey", "inverted", "red", "green", "blue", "cyan", "magenta", "yellow", "fire", "viridis"]);
    for (const l of builtinLuts) expect(l.name).not.toBe("");
  });

  it("each give a 256 x 3 table, the same one each call", () => {
    for (const l of builtinLuts) {
      expect(l.table()).toBeInstanceOf(Uint8Array);
      expect(l.table().length).toBe(768);
      expect(l.table()).toBe(l.table());
    }
  });

  it("grey, inverted and the single and paired colours ramp as named", () => {
    for (const i of [0, 1, 127, 128, 254, 255]) {
      expect(at("grey", i)).toEqual([i, i, i]);
      expect(at("inverted", i)).toEqual([255 - i, 255 - i, 255 - i]);
      expect(at("red", i)).toEqual([i, 0, 0]);
      expect(at("green", i)).toEqual([0, i, 0]);
      expect(at("blue", i)).toEqual([0, 0, i]);
      expect(at("cyan", i)).toEqual([0, i, i]);
      expect(at("magenta", i)).toEqual([i, 0, i]);
      expect(at("yellow", i)).toEqual([i, i, 0]);
    }
  });

  it("viridis is matplotlib's table", () => {
    expect(at("viridis", 0)).toEqual([68, 1, 84]);
    expect(at("viridis", 128)).toEqual([33, 145, 140]);
    expect(at("viridis", 255)).toEqual([253, 231, 37]);
  });

  it("fire runs from black to white through ImageJ's control points", () => {
    expect(at("fire", 0)).toEqual([0, 0, 0]);
    expect(at("fire", 8)).toEqual([0, 0, 61]);
    expect(at("fire", 4)).toEqual([0, 0, 30]);
    expect(at("fire", 255)).toEqual([255, 255, 255]);
  });
});

describe("LutRegistry", () => {
  const make = (id: string, name = id): Lut => ({ id, name, table: () => new Uint8Array(768) });

  it("keeps registration order and replaces a re-registered id in place", () => {
    const registry = new LutRegistry();
    registry.register(make("a"));
    registry.register(make("b"));
    registry.register(make("c"));
    registry.register(make("b", "B again"));
    expect(registry.all().map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect(registry.get("b")?.name).toBe("B again");
    expect(registry.get("missing")).toBeUndefined();
  });
});
