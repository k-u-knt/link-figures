import { createPage } from "../../src/model/defaults";
import { PAGE_PRESETS } from "../../src/model/presets";
import { applyPreset, clampPageSize, nodeBaseFields, pageFields, readValue, writePageField, writeValue } from "../../src/view/page-fields";

test("applyPreset sets size and keeps paper", () => { const p = createPage("a4-portrait", []); p.paper = "#eeeeee"; const q = applyPreset(p, "nature-double"); expect(q).toMatchObject({ preset: "nature-double", width: 183, height: 170, paper: "#eeeeee" }); });
test("page fields include preset select with custom", () => { const f = pageFields().find(f => f.key === "preset")!; expect(f.kind).toBe("select"); expect(f.options!.some(o => o.value === "custom")).toBe(true); });
test("margins round-trip through dotted keys", () => { const p = createPage("a4-portrait", []); writeValue(p, "margins.left", 12); expect(readValue(p, "margins.left")).toBe(12); });

test("the preset select lists every preset by name, then Custom", () => {
  const options = pageFields().find((f) => f.key === "preset")!.options!;
  expect(options.slice(0, -1)).toEqual(PAGE_PRESETS.map((p) => ({ value: p.id, label: p.name })));
  expect(options[options.length - 1]).toEqual({ value: "custom", label: "Custom" });
});

test("page fields: size and margins are millimetre numbers, paper is a colour", () => {
  const byKey = new Map(pageFields().map((f) => [f.key, f] as const));
  expect([...byKey.keys()]).toEqual(["preset", "width", "height", "paper", "margins.top", "margins.right", "margins.bottom", "margins.left"]);
  expect(byKey.get("width")).toMatchObject({ kind: "number", unit: "mm", min: 10, step: 0.5 });
  expect(byKey.get("height")).toMatchObject({ kind: "number", unit: "mm", min: 10, step: 0.5 });
  expect(byKey.get("paper")!.kind).toBe("color");
  // It may be transparent: a nullable colour (see the inspector's page section).
  expect(byKey.get("paper")!.nullable).toBe(true);
  for (const side of ["top", "right", "bottom", "left"]) expect(byKey.get(`margins.${side}`)).toMatchObject({ kind: "number", unit: "mm", min: 0 });
});

test("applyPreset does not change the page it is given", () => {
  const p = createPage("a4-portrait", []);
  applyPreset(p, "nature-double");
  expect(p).toMatchObject({ preset: "a4-portrait", width: 210, height: 297 });
});

test("applyPreset with custom (or an id that is not a preset) leaves the size alone", () => {
  const p = createPage("a4-portrait", []);
  p.width = 123;
  expect(applyPreset(p, "custom")).toMatchObject({ preset: "custom", width: 123, height: 297 });
  expect(applyPreset(p, "gone")).toMatchObject({ preset: "custom", width: 123, height: 297 });
});

test("node base fields: geometry in millimetres, then rotation, opacity, name and locked", () => {
  const fields = nodeBaseFields();
  expect(fields.map((f) => f.key)).toEqual(["x", "y", "width", "height", "rotation", "opacity", "name", "locked"]);
  const byKey = new Map(fields.map((f) => [f.key, f] as const));
  for (const key of ["x", "y", "width", "height"]) expect(byKey.get(key)).toMatchObject({ kind: "number", unit: "mm", step: 0.1 });
  expect(byKey.get("opacity")).toMatchObject({ kind: "number", min: 0, max: 1, step: 0.05 });
  expect(byKey.get("name")!.kind).toBe("text");
  expect(byKey.get("locked")!.kind).toBe("toggle");
});

test("readValue and writeValue follow dotted keys through nested objects", () => {
  const node = { font: { size: 7 }, x: 1 };
  expect(readValue(node, "font.size")).toBe(7);
  writeValue(node, "font.size", 9);
  expect(node.font.size).toBe(9);
  writeValue(node, "x", 2);
  expect(node.x).toBe(2);
});

test("readValue gives undefined for a path that is not there, and writeValue makes the objects on the way", () => {
  const o: Record<string, any> = {};
  expect(readValue(o, "a.b.c")).toBeUndefined();
  writeValue(o, "a.b", 1);
  expect(o).toEqual({ a: { b: 1 } });
});

test("writeValue refuses keys that would reach the prototype", () => {
  const o: Record<string, any> = {};
  writeValue(o, "__proto__.polluted", true);
  writeValue(o, "constructor.prototype.polluted", true);
  expect(({} as any).polluted).toBeUndefined();
});

test("writePageField: the preset select sets the size, and custom keeps it", () => {
  const p = createPage("a4-portrait", []);
  writePageField(p, "preset", "nature-single");
  expect(p).toMatchObject({ preset: "nature-single", width: 89, height: 170 });
  writePageField(p, "preset", "custom");
  expect(p).toMatchObject({ preset: "custom", width: 89, height: 170 });
});

test("writePageField: a size that is no longer the preset's makes the page custom", () => {
  const p = createPage("a4-portrait", []);
  writePageField(p, "width", 200);
  expect(p).toMatchObject({ preset: "custom", width: 200, height: 297 });
  // Back to the preset's size does not bring the preset back: it is a choice, not an inference.
  writePageField(p, "width", 210);
  expect(p.preset).toBe("custom");
});

test("writePageField: other fields are plain writes", () => {
  const p = createPage("a4-portrait", []);
  writePageField(p, "paper", "#f4f4f4");
  writePageField(p, "margins.left", 15);
  expect(p).toMatchObject({ preset: "a4-portrait", paper: "#f4f4f4", margins: { left: 15 } });
});

test("clampPageSize: a size over the limit is brought to it", () => {
  expect(clampPageSize(2500, 2000)).toEqual({ value: 2000, clamped: true });
  expect(clampPageSize(183, 2000)).toEqual({ value: 183, clamped: false });
});

test("writePageField: a width over the limit is set to the limit and reported", () => {
  const p = createPage("a4-portrait", []);
  expect(writePageField(p, "width", 2500, 2000)).toBe(true);
  expect(p).toMatchObject({ preset: "custom", width: 2000, height: 297 });
  expect(writePageField(p, "height", 400, 2000)).toBe(false);
  expect(p.height).toBe(400);
});

test("writePageField: a preset is applied whole unless it is over the limit", () => {
  const p = createPage("a4-portrait", []);
  expect(writePageField(p, "preset", "a4-landscape", 2000)).toBe(false);
  expect(p).toMatchObject({ preset: "a4-landscape", width: 297, height: 210 });
  expect(writePageField(p, "preset", "a4-portrait", 250)).toBe(true);
  expect(p).toMatchObject({ preset: "custom", width: 210, height: 250 });
});
