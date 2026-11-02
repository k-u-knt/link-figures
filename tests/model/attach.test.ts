import { attachTarget } from "../../src/model/attach";
import { createDocument, createPage, fileNodeDefaults, shapeNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { pathBounds } from "../../src/model/path";
import type { Document, Node } from "../../src/model/types";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { textNodeType } from "../../src/nodes/text-node";
import { createRegistries } from "../../src/registry";
import { ellipseShape, rectShape } from "../../src/shapes/builtin";

// `obsidian` ships only typings, so the file node module needs a stand-in; the contract under test never touches it.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));
const { fileNodeType } = await import("../../src/nodes/file-node");

const registries = createRegistries();
registries.nodeTypes.register(fileNodeType);
registries.nodeTypes.register(textNodeType);
registries.nodeTypes.register(shapeNodeType);
registries.shapes.register(rectShape);
registries.shapes.register(ellipseShape);

const page = createPage("a4-portrait", []);
const docWith = (...nodes: Node[]): Document => ({ ...createDocument("a4-portrait"), nodes });
const anchor = (t: NonNullable<ReturnType<typeof attachTarget>>, id: string) => t.anchors.find((a) => a.id === id)!;

test("a text node attaches as its box with anchors n e s w", () => {
  const text = { ...textNodeDefaults(page, {}, []), id: "t", x: 10, y: 20, width: 100, height: 40 };
  const t = attachTarget(docWith(text), registries, "t")!;
  expect(t.center).toEqual({ x: 60, y: 40 });
  expect(pathBounds(t.outline)).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  expect(t.anchors.map((a) => a.id)).toEqual(["n", "e", "s", "w"]);
  expect(anchor(t, "n")).toEqual({ id: "n", x: 60, y: 20, dir: { x: 0, y: -1 } });
});

test("a file node rotated 90 degrees has its n anchor on the right, pointing right", () => {
  const file = { ...fileNodeDefaults(page, { file: "a.png", subpath: "", show: "image" }, []), id: "f", x: 0, y: 0, width: 100, height: 50, rotation: 90 };
  const t = attachTarget(docWith(file), registries, "f")!;
  const n = anchor(t, "n");
  expect(n.x).toBeCloseTo(75);
  expect(n.y).toBeCloseTo(25);
  expect(n.dir.x).toBeCloseTo(1);
  expect(n.dir.y).toBeCloseTo(0);
  const b = pathBounds(t.outline);
  expect([b.x, b.y, b.width, b.height].map(Math.round)).toEqual([25, -25, 50, 100]);
  expect(t.center).toEqual({ x: 50, y: 25 });
});

test("a shape attaches through its kind, rotated with the node", () => {
  const shape = { ...shapeNodeDefaults(page, { kind: "ellipse", params: {} }, []), id: "s", x: 0, y: 0, width: 100, height: 50, rotation: 180 };
  const t = attachTarget(docWith(shape), registries, "s")!;
  const n = anchor(t, "n");
  expect(n.x).toBeCloseTo(50);
  expect(n.y).toBeCloseTo(50);
  expect(n.dir.y).toBeCloseTo(1);
});

test("an unrotated shape's outline and anchors are the kind's own", () => {
  const shape = { ...shapeNodeDefaults(page, {}, []), id: "s", x: 5, y: 5, width: 20, height: 10 };
  const t = attachTarget(docWith(shape), registries, "s")!;
  expect(t.outline).toEqual(rectShape.outline({ x: 5, y: 5, width: 20, height: 10 }, shape.params));
  expect(t.anchors).toEqual(rectShape.anchors({ x: 5, y: 5, width: 20, height: 10 }, shape.params));
});

test("a shape of an unregistered kind attaches as its box", () => {
  const shape = { ...shapeNodeDefaults(page, { kind: "nope", params: {} }, []), id: "s", x: 0, y: 0, width: 20, height: 10 };
  expect(attachTarget(docWith(shape), registries, "s")!.anchors.map((a) => a.id)).toEqual(["n", "e", "s", "w"]);
});

test("a connector, an unregistered type and a missing id give null", () => {
  const connector = { ...textNodeDefaults(page, {}, []), id: "c", type: "connector" } as unknown as Node;
  registries.nodeTypes.register({ ...textNodeType, type: "connector" as never, attachable: undefined });
  expect(attachTarget(docWith(connector), registries, "c")).toBeNull();
  const stranger = { ...connector, id: "u", type: "unknown" } as unknown as Node;
  expect(attachTarget(docWith(stranger), registries, "u")).toBeNull();
  expect(attachTarget(docWith(), registries, "missing")).toBeNull();
});
