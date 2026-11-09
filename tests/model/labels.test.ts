import { createDocument, fileNodeDefaults, groupNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { nodeLabel } from "../../src/model/labels";
import type { ConnectorNode, Node } from "../../src/model/types";

const doc = createDocument("a4-portrait");
const page = doc.pages[0];
const file = (path: string, over: Partial<Node> = {}) => ({ ...fileNodeDefaults(page, { file: path, subpath: "", show: "image" }, []), id: "p-1", ...over }) as Node;
const text = (content: string) => ({ ...textNodeDefaults(page, {}, []), id: "t-1", text: content });

test("an item is named by its name and its page", () => {
  expect(nodeLabel(doc, file("plots/fig2b.pdf", { name: "PNG cropped" }))).toBe(`"PNG cropped" (${page.name})`);
  expect(nodeLabel(doc, { ...text("Scale bar"), name: "Legend" })).toBe(`"Legend" (${page.name})`);
});

test("an item without a name is named by its id, whatever its type or file", () => {
  expect(nodeLabel(doc, file("plots/fig2b.pdf"))).toBe(`"p-1" (${page.name})`);
  expect(nodeLabel(doc, file("plots/fig2b.pdf", { name: "" }))).toBe(`"p-1" (${page.name})`);
  expect(nodeLabel(doc, text("Scale bar 10 µm and more"))).toBe(`"t-1" (${page.name})`);
  expect(nodeLabel(doc, { ...file(""), id: "x-1", type: "x.chart" } as never)).toBe(`"x-1" (${page.name})`);
});

test("two panels of one file are told apart", () => {
  expect(nodeLabel(doc, file("plot.png", { id: "p-a" }))).not.toBe(nodeLabel(doc, file("plot.png", { id: "p-b" })));
});

test("a group named in the figure is called by that name, not 'Group'", () => {
  const group = { ...groupNodeDefaults(page, {}, []), id: "g-1", name: "Split group" } as Node;
  expect(nodeLabel(doc, group)).toBe(`"Split group" (${page.name})`);
});

test("the page is left out when the node's page is not in the document", () => {
  expect(nodeLabel(doc, { ...file("a.pdf"), page: "pg-gone" })).toBe('"p-1"');
});

test("a connector is named by its id", () => {
  const { text: _text, font: _font, ...base } = text("");
  const connector: ConnectorNode = {
    ...base,
    id: "k-bar",
    type: "connector",
    ends: [{ kind: "free", x: 0, y: 0 }, { kind: "free", x: 1, y: 1 }],
    route: "straight",
    routeParams: {},
    stroke: { paint: { type: "none" }, width: 1, dash: "solid" },
    caps: [{ kind: "none", size: 3 }, { kind: "none", size: 3 }],
  };
  expect(nodeLabel(doc, connector)).toBe(`"k-bar" (${page.name})`);
});
