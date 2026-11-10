import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import type { Node } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { fileNodeType } from "../../src/nodes/file-node";
import { createRegistries } from "../../src/registry";
import type { NodeType } from "../../src/registry/node-type";
import { resolvableAs } from "../../src/view/node-host";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {}, Menu: class {}, Notice: class {}, Modal: class {}, ItemView: class {}, TextFileView: class {} }));

function registries() {
  const r = createRegistries();
  r.nodeTypes.register(fileNodeType);
  r.nodeTypes.register(cardNodeType);
  return r;
}

test("a file panel's link is resolved through its type's linkTarget, as itself", () => {
  const r = registries();
  const doc = createDocument("a4-portrait");
  const panel = fileNodeDefaults(doc.pages[0], { file: "a.tif", subpath: "", show: "image", imageIndex: 2, pageIndex: 1, range: "full" as never }, []);
  doc.nodes.push(panel);
  expect(fileNodeType.linkTarget?.(panel)).toBeTruthy();
  expect(resolvableAs(r, panel, doc)).toEqual(panel);
});

test("a file node is resolved only by a registered type with a linkTarget, like any other type", () => {
  const r = createRegistries();
  r.nodeTypes.register({ ...fileNodeType, linkTarget: undefined } as unknown as NodeType);
  const doc = createDocument("a4-portrait");
  const panel = fileNodeDefaults(doc.pages[0], { file: "a.png", subpath: "", show: "image" }, []);
  expect(resolvableAs(r, panel, doc)).toBeNull();
});

test("a note card resolves as a panel of its note's content; a text card has none", () => {
  const r = registries();
  const doc = createDocument("a4-portrait");
  const card = { ...cardNodeDefaults(doc.pages[0], 900, 0), id: "c", file: "Notes/n.md", subpath: "" } as Node;
  expect(resolvableAs(r, card, doc)).toMatchObject({ id: "c", type: "file", file: "Notes/n.md", show: "content" });
  const text = { ...cardNodeDefaults(doc.pages[0], 900, 0), id: "t" } as Node;
  expect(resolvableAs(r, text, doc)).toBeNull();
});
