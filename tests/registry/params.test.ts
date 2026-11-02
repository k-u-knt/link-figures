import { isEnd, isPaint, isStroke, validateArgs, type ParamSpec } from "../../src/registry/params";

const spec: ParamSpec = {
  ids: { type: "array", required: true },
  kind: { type: "string", default: "rect", enum: ["rect", "ellipse"] },
  x: { type: "number" },
  locked: { type: "boolean" },
  params: { type: "object", default: { cornerRadius: 0 } },
  from: { type: "end" },
  fill: { type: "paint" },
  border: { type: "stroke" },
};

test("a valid call gives its arguments with the defaults of those not given", () => {
  const result = validateArgs(spec, { ids: ["p-a"], x: 3 });
  expect(result).toEqual({ ok: true, value: { ids: ["p-a"], kind: "rect", x: 3, params: { cornerRadius: 0 } } });
});

test("a default is copied, so changing what a call was given does not change the next call's default", () => {
  const first = validateArgs(spec, { ids: [] });
  if (!first.ok) throw new Error(first.error);
  (first.value.params as Record<string, unknown>).cornerRadius = 9;
  expect(validateArgs(spec, { ids: [] })).toMatchObject({ ok: true, value: { params: { cornerRadius: 0 } } });
});

test("no arguments are an empty object", () => {
  expect(validateArgs({ x: { type: "number" } }, undefined)).toEqual({ ok: true, value: {} });
  expect(validateArgs({}, null)).toEqual({ ok: true, value: {} });
});

test.each([
  [{}, 'parameter "ids" is required'],
  [{ ids: "p-a" }, 'parameter "ids" must be an array'],
  [{ ids: [], x: "3" }, 'parameter "x" must be a finite number'],
  [{ ids: [], x: Infinity }, 'parameter "x" must be a finite number'],
  [{ ids: [], locked: 1 }, 'parameter "locked" must be true or false'],
  [{ ids: [], params: [] }, 'parameter "params" must be an object'],
  [{ ids: [], kind: "star" }, 'parameter "kind" must be one of "rect", "ellipse"'],
  [{ ids: [], from: { kind: "free", x: 1 } }, 'parameter "from" must be an end'],
  [{ ids: [], fill: "#ff0000" }, 'parameter "fill" must be a paint'],
  [{ ids: [], border: { paint: { type: "solid" }, width: -1, dash: "solid" } }, 'parameter "border" must be a stroke'],
  [{ ids: [], colour: "#ff0000" }, 'unknown parameter "colour"'],
])("%j is refused, and the error names the parameter: %s", (args, error) => {
  const result = validateArgs(spec, args);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.startsWith(error)).toBe(true);
});

test("arguments that are not an object of named parameters are refused", () => {
  expect(validateArgs(spec, ["p-a"])).toEqual({ ok: false, error: "the arguments must be an object of named parameters" });
  expect(validateArgs(spec, 3).ok).toBe(false);
});

test("ends, paints and strokes are checked for the model's shapes", () => {
  expect(isEnd({ kind: "free", x: 0, y: 1 })).toBe(true);
  expect(isEnd({ kind: "attached", node: "p-a", snap: "center" })).toBe(true);
  expect(isEnd({ kind: "attached", node: "p-a", snap: "anchor", anchor: "e" })).toBe(true);
  expect(isEnd({ kind: "attached", node: "p-a", snap: "anchor" })).toBe(false);
  expect(isEnd({ kind: "free", x: NaN, y: 1 })).toBe(false);
  // A paint type this plugin does not know is still a paint: its own params are its type's to check.
  expect(isPaint({ type: "hatch", angle: 45 })).toBe(true);
  expect(isPaint({ color: "#000000" })).toBe(false);
  expect(isStroke({ paint: { type: "solid", color: "#000000" }, width: 1, dash: "dash", cap: "round" })).toBe(true);
  expect(isStroke({ paint: { type: "solid" }, width: 1, dash: "wavy" })).toBe(false);
  expect(isStroke({ paint: { type: "solid" }, width: 1, dash: "solid", join: "sharp" })).toBe(false);
});

test("a nullable parameter takes null as well as its type", () => {
  const nullable: ParamSpec = { border: { type: "stroke", nullable: true } };
  expect(validateArgs(nullable, { border: null })).toEqual({ ok: true, value: { border: null } });
  expect(validateArgs(nullable, { border: 3 })).toEqual({ ok: false, error: 'parameter "border" must be a stroke ({paint, width, dash, cap?, join?}) or null' });
  expect(validateArgs(spec, { ids: [], border: null })).toMatchObject({ ok: false });
});
