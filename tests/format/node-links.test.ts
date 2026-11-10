import { loadDocument } from "../../src/format/load";
import { linkOf } from "../../src/format/node-links";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument } from "../../src/model/defaults";
import type { Node } from "../../src/model/types";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";

test("a plugin type that opts in with linkField keeps its link in the Links section and round-trips", () => {
  const registries = createRegistries();
  registries.nodeTypes.register({
    type: "x.excerpt",
    name: "Excerpt",
    icon: "quote",
    linkField: { always: false },
    mount: () => ({ update() {}, unmount() {} }),
    bounds: (n: Node) => n,
    inspector: () => [],
    toSvg: () => "",
  } as unknown as NodeType);
  const doc = createDocument("a4-portrait");
  const base = { page: doc.pages[0].id, x: 0, y: 0, width: 10, height: 10, z: 0, rotation: 0, opacity: 1, locked: false };
  doc.nodes.push(
    { ...base, id: "x-1", type: "x.excerpt", file: "Notes/a.md", subpath: "#Results", quote: true } as unknown as Node,
    { ...base, id: "x-2", type: "x.excerpt", quote: false } as unknown as Node,
  );
  const text = serializeFigureFile(doc, emptyParsed());
  expect(text).toContain("- x-1: ![[Notes/a.md#Results]] ^x-1");
  expect(text).not.toContain("- x-2:");
  expect(text.slice(text.indexOf("## Figure"))).not.toContain("Notes/a.md");
  const loaded = loadDocument(text, registries);
  expect(loaded.doc.nodes[0]).toMatchObject({ file: "Notes/a.md", subpath: "#Results", quote: true });
  expect(linkOf(loaded.doc.nodes[1])).toBeNull();
  expect(serializeFigureFile(loaded.doc, loaded.parsed)).toBe(text);
});

test("a type that does not opt in keeps its file key in the JSON", () => {
  const doc = createDocument("a4-portrait");
  doc.nodes.push({ id: "y-1", type: "y.other", page: doc.pages[0].id, x: 0, y: 0, width: 1, height: 1, z: 0, rotation: 0, opacity: 1, locked: false, file: "keep.md" } as unknown as Node);
  const text = serializeFigureFile(doc, emptyParsed());
  expect(text).not.toContain("- y-1:");
  expect(text).toContain('"file": "keep.md"');
});
