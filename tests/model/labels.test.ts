import { createDocument, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { nodeLabel } from "../../src/model/labels";
import type { ConnectorNode } from "../../src/model/types";

const doc = createDocument("a4-portrait");
const page = doc.pages[0];
const file = (path: string) => fileNodeDefaults(page, { file: path, subpath: "", show: "image" }, []);
const text = (content: string) => ({ ...textNodeDefaults(page, {}, []), text: content });

test("a panel is named by its file's base name and its page", () => {
  expect(nodeLabel(doc, file("fig2b.pdf"))).toBe(`Panel "fig2b.pdf" (${page.name})`);
  expect(nodeLabel(doc, file("plots/sub/fig2b.pdf"))).toBe(`Panel "fig2b.pdf" (${page.name})`);
});

test("a panel with no link says so", () => {
  expect(nodeLabel(doc, file(""))).toBe(`Panel (no link) (${page.name})`);
});

test("a text node is named by its first four words, with an ellipsis only when cut", () => {
  expect(nodeLabel(doc, text("Scale bar 10 µm and more"))).toBe(`Text "Scale bar 10 µm…" (${page.name})`);
  expect(nodeLabel(doc, text("Scale  bar\n10 µm"))).toBe(`Text "Scale bar 10 µm" (${page.name})`);
});

test("the page is left out when the node's page is not in the document", () => {
  expect(nodeLabel(doc, { ...file("a.pdf"), page: "pg-gone" })).toBe('Panel "a.pdf"');
});

test("a connector is named as such", () => {
  const { text: _text, font: _font, ...base } = text("");
  const connector: ConnectorNode = {
    ...base,
    type: "connector",
    ends: [{ kind: "free", x: 0, y: 0 }, { kind: "free", x: 1, y: 1 }],
    route: "straight",
    routeParams: {},
    stroke: { paint: { type: "none" }, width: 1, dash: "solid" },
    caps: [{ kind: "none", size: 3 }, { kind: "none", size: 3 }],
  };
  expect(nodeLabel(doc, connector)).toBe(`Connector (${page.name})`);
});
