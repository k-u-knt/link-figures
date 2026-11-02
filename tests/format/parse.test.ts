import { isFigureText, parseFigureFile } from "../../src/format/parse";
import { emitLinksSection, joinLinktext, parseLinksSection, splitLinktext } from "../../src/format/links-section";
import { loadDocument } from "../../src/format/load";
import { serializeFigureFile } from "../../src/format/serialize";
import { migrate } from "../../src/format/migrate";
import { FormatError, NotFigureError } from "../../src/format/errors";
import { connectorNodeDefaults, fileNodeDefaults, createPage } from "../../src/model/defaults";
import { DEFAULT_FONT } from "../../src/constants";
import type { FileNode, TextNode } from "../../src/model/types";

const FILE = `---\nlink-figures: 1\ntitle: Fig 2\n---\n\nSome notes.\n\n## Links\n- p-3f9a: ![[analysis#^fig2b]] ^p-3f9a\n- p-8c21: ![[plots/plot.png]] ^p-8c21\n\n## Figure\n\`\`\`lnkfig\n{"version":1,"pages":[{"id":"pg-1","name":"Page 1","width":183,"height":170,"paper":"#ffffff","margins":{"top":0,"right":0,"bottom":0,"left":0},"grid":{"spacing":5,"show":false}}],"nodes":[{"id":"p-3f9a","type":"file","page":"pg-1","x":0,"y":0,"width":100,"height":50,"z":0,"rotation":0,"opacity":1,"locked":false,"show":"image","imageIndex":0,"crop":null,"fit":"cover","scale":1,"frame":null},{"id":"p-8c21","type":"file","page":"pg-1","x":0,"y":60,"width":100,"height":50,"z":1,"rotation":0,"opacity":1,"locked":false,"show":"image","imageIndex":0,"crop":null,"fit":"cover","scale":1,"frame":null}],"edges":[]}\n\`\`\`\nAfterword.\n`;
test("parses sections", () => { const p = parseFigureFile(FILE); expect(p.frontmatter).toBe("---\nlink-figures: 1\ntitle: Fig 2\n---\n"); expect(p.preamble).toBe("\nSome notes.\n\n"); expect(p.links).toEqual([{ id: "p-3f9a", linktext: "analysis#^fig2b" }, { id: "p-8c21", linktext: "plots/plot.png" }]); expect(p.bodyJson).toMatch(/^\{"version":1/); expect(p.trailing).toBe("Afterword.\n"); });
test("splitLinktext", () => { expect(splitLinktext("analysis#^fig2b")).toEqual({ file: "analysis", subpath: "#^fig2b" }); expect(splitLinktext("plots/plot.png")).toEqual({ file: "plots/plot.png", subpath: "" }); });
test("loadDocument merges links into nodes", () => { const { doc } = loadDocument(FILE); const n = doc.nodes[0] as FileNode; expect(n.file).toBe("analysis"); expect(n.subpath).toBe("#^fig2b"); });
test("not a figure", () => expect(() => parseFigureFile("---\ntitle: x\n---\nhello")).toThrow(NotFigureError));
test("corrupt JSON throws FormatError", () => expect(() => loadDocument(FILE.replace('"version":1', '"version":'))).toThrow(FormatError));
test("marker but no body gives a default document", () => { const { doc } = loadDocument("---\nlink-figures: 1\n---\n"); expect(doc.pages).toHaveLength(1); expect(doc.nodes).toEqual([]); });
test("orphan link entry is dropped and node without entry gets empty file", () => { const text = FILE.replace("- p-8c21: ![[plots/plot.png]] ^p-8c21", "- p-zzzz: ![[ghost.png]] ^p-zzzz"); const { doc } = loadDocument(text); expect(doc.nodes).toHaveLength(2); expect((doc.nodes[1] as FileNode).file).toBe(""); });
test("CRLF input is normalised", () => { const p = parseFigureFile(FILE.replace(/\n/g, "\r\n")); expect(p.links).toHaveLength(2); });
test("a leading byte order mark is dropped: the file is still a figure, and parses as without it", () => { const withBom = "\uFEFF" + FILE; expect(isFigureText(withBom)).toBe(true); expect(parseFigureFile(withBom)).toEqual(parseFigureFile(FILE)); expect(parseFigureFile("\uFEFF" + FILE.replace(/\n/g, "\r\n")).frontmatter).toBe("---\nlink-figures: 1\ntitle: Fig 2\n---\n"); });

// --- detection, structure edge cases
test("isFigureText detects the frontmatter key only", () => {
  expect(isFigureText(FILE)).toBe(true);
  expect(isFigureText("---\ntitle: x\n---\nlink-figures: 1\n")).toBe(false);
  expect(isFigureText("link-figures: 1\n")).toBe(false);
  expect(isFigureText("# just a note")).toBe(false);
});
test("an unterminated lnkfig fence is a FormatError", () => expect(() => parseFigureFile("---\nlink-figures: 1\n---\n## Figure\n```lnkfig\n{}\n")).toThrow(FormatError));
test("marker without a Figure section has bodyJson null and keeps the text", () => { const p = parseFigureFile("---\nlink-figures: 1\n---\nJust notes.\n"); expect(p.bodyJson).toBeNull(); expect(p.preamble).toBe("Just notes.\n"); expect(p.links).toEqual([]); expect(p.trailing).toBe(""); });
test("headings inside a fenced block in the preamble are not sections", () => { const text = "---\nlink-figures: 1\n---\n```md\n## Links\n- p-aaaa: ![[x.png]] ^p-aaaa\n## Figure\n```\n\n## Figure\n```lnkfig\n{}\n```\n"; const p = parseFigureFile(text); expect(p.links).toEqual([]); expect(p.preamble).toBe("```md\n## Links\n- p-aaaa: ![[x.png]] ^p-aaaa\n## Figure\n```\n\n"); expect(p.bodyJson).toBe("{}"); });
test("an unclosed non-lnkfig fence in the preamble is a FormatError, not a silent default document", () => {
  const stray = "---\nlink-figures: 1\n---\nnotes\n```\nstray fence\n";
  expect(() => parseFigureFile(stray)).toThrow(FormatError);
  expect(() => loadDocument(stray)).toThrow(FormatError);
  expect(() => parseFigureFile("---\nlink-figures: 1\n---\n```js\nnever closed\n")).toThrow(FormatError);
  expect(() => parseFigureFile("---\nlink-figures: 1\n---\n~~~\nnever closed\n")).toThrow(FormatError);
  expect(() => parseFigureFile("---\nlink-figures: 1\n---\n## Links\n- p-1: ![[a.png]] ^p-1\n```\nstray\n")).toThrow(FormatError);
});
test("a differently-tagged fence before the lnkfig block is skipped", () => { const p = parseFigureFile("---\nlink-figures: 1\n---\n## Figure\n```json\n{\"no\":1}\n```\n```lnkfig\n{\"yes\":1}\n```\n"); expect(p.bodyJson).toBe('{"yes":1}'); });
test("a Figure heading without a lnkfig block gives bodyJson null", () => { const p = parseFigureFile("---\nlink-figures: 1\n---\n## Figure\nnothing here\n"); expect(p.bodyJson).toBeNull(); expect(p.trailing).toBe("nothing here\n"); });

// --- links section
test("parseLinksSection reads list items and ignores other lines", () => { expect(parseLinksSection("\nsome prose\n- p-1: ![[a b#Sec]] ^p-1\n* p-2: ![[c.png]]\n- not a link\n\n")).toEqual([{ id: "p-1", linktext: "a b#Sec" }, { id: "p-2", linktext: "c.png" }]); });
test("emitLinksSection writes the header, one line per entry and a blank line", () => { expect(emitLinksSection([{ id: "p-1", linktext: "a#^b" }])).toBe("## Links\n- p-1: ![[a#^b]] ^p-1\n\n"); expect(emitLinksSection([])).toBe("## Links\n\n"); });
test("joinLinktext reverses splitLinktext", () => { for (const t of ["a", "a#b", "a/b.png", "a#^x"]) { const { file, subpath } = splitLinktext(t); expect(joinLinktext(file, subpath)).toBe(t); } });

// --- migrate
const minimalPage = { id: "pg-1", name: "P", width: 100, height: 100, paper: "#ffffff", margins: { top: 0, right: 0, bottom: 0, left: 0 }, grid: { spacing: 5, show: false } };
const geom = { page: "pg-1", x: 1, y: 2, width: 30, height: 40 };
const docWith = (nodes: unknown[], extra: object = {}) => ({ version: 1, pages: [minimalPage], nodes, edges: [], ...extra });
test("migrate fills file defaults, agreeing with fileNodeDefaults", () => {
  const doc = migrate(docWith([{ id: "p-1", type: "file", ...geom }]));
  const n = doc.nodes[0] as FileNode;
  const { id: _id, page: _page, x: _x, y: _y, width: _w, height: _h, ...defaults } = fileNodeDefaults(createPage("a4-portrait", []), { file: "", subpath: "", show: "image" }, []);
  expect(n).toMatchObject({ id: "p-1", ...geom, ...defaults });
});
test("migrate fills text defaults with a copy of DEFAULT_FONT", () => {
  const doc = migrate(docWith([{ id: "p-1", type: "text", ...geom }, { id: "p-2", type: "text", ...geom }]));
  const [a, b] = doc.nodes as TextNode[];
  expect(a).toMatchObject({ text: "", z: 0, rotation: 0, opacity: 1, locked: false, font: DEFAULT_FONT });
  expect(a.font).not.toBe(DEFAULT_FONT);
  expect(a.font).not.toBe(b.font);
});
test("migrate fills the missing keys of a partial font", () => { const [n] = migrate(docWith([{ id: "p-1", type: "text", ...geom, font: { size: 12 } }])).nodes as TextNode[]; expect(n.font).toEqual({ ...DEFAULT_FONT, size: 12 }); });
test("migrate keeps values that are present", () => { const [n] = migrate(docWith([{ id: "p-1", type: "file", ...geom, z: 5, opacity: 0.5, locked: true, range: { min: 1, max: 3 } }])).nodes as FileNode[]; expect(n).toMatchObject({ z: 5, opacity: 0.5, locked: true, range: { min: 1, max: 3 } }); });
test("migrate preserves unknown keys on the document, pages and nodes", () => {
  const doc = migrate({ ...docWith([{ id: "p-1", type: "text", ...geom, futureKey: [1] }], { meta: { a: 1 } }), pages: [{ ...minimalPage, extra: true }] });
  expect((doc as unknown as Record<string, unknown>).meta).toEqual({ a: 1 });
  expect((doc.pages[0] as unknown as Record<string, unknown>).extra).toBe(true);
  expect((doc.nodes[0] as unknown as Record<string, unknown>).futureKey).toEqual([1]);
});
test("migrate fills page defaults", () => { const doc = migrate({ version: 1, pages: [{ id: "pg-1", width: 10, height: 20 }], nodes: [] }); expect(doc.pages[0]).toEqual({ id: "pg-1", name: "Page 1", width: 10, height: 20, paper: "#ffffff", margins: { top: 0, right: 0, bottom: 0, left: 0 }, grid: { spacing: 5, show: false } }); expect(doc.edges).toEqual([]); });
test("migrate rejects unknown node types", () => expect(() => migrate(docWith([{ id: "p-1", type: "hologram", ...geom }]))).toThrow(FormatError));
test("migrate does not mistake inherited object members for node types", () => expect(() => migrate(docWith([{ id: "p-1", type: "constructor", ...geom }]))).toThrow(FormatError));
test("migrate fills the missing keys of partial margins and grid", () => { const doc = migrate({ version: 1, pages: [{ id: "pg-1", width: 10, height: 20, margins: { top: 5 }, grid: { show: true } }], nodes: [] }); expect(doc.pages[0].margins).toEqual({ top: 5, right: 0, bottom: 0, left: 0 }); expect(doc.pages[0].grid).toEqual({ spacing: 5, show: true }); });
test("migrate rejects other versions", () => { expect(() => migrate({ ...docWith([]), version: 2 })).toThrow(FormatError); expect(() => migrate({ pages: [], nodes: [] })).toThrow(FormatError); });
test.each([
  ["not an object", [1, 2]],
  ["pages missing", { version: 1, nodes: [] }],
  ["nodes missing", { version: 1, pages: [] }],
  ["node without id", docWith([{ type: "text", ...geom }])],
  ["node without type", docWith([{ id: "p-1", ...geom }])],
  ["node without page", docWith([{ id: "p-1", type: "text", x: 0, y: 0, width: 1, height: 1 }])],
  ["node with a non-numeric width", docWith([{ id: "p-1", type: "text", ...geom, width: "wide" }])],
  ["page without a width", { version: 1, pages: [{ id: "pg-1", height: 5 }], nodes: [] }],
])("migrate rejects malformed input: %s", (_name, json) => expect(() => migrate(json)).toThrow(FormatError));

// --- connectors
const ends = [{ kind: "free", x: 0, y: 0 }, { kind: "attached", node: "p-2", snap: "center" }];
test("migrate fills connector defaults, agreeing with connectorNodeDefaults", () => {
  const [n] = migrate(docWith([{ id: "p-1", type: "connector", ...geom, ends }])).nodes;
  const { id: _id, type: _type, page: _page, x: _x, y: _y, width: _w, height: _h, ends: _ends, ...defaults } = connectorNodeDefaults(createPage("a4-portrait", []), {}, []);
  expect(n).toEqual({ id: "p-1", ...geom, type: "connector", ...defaults, ends });
});
test("a connector's old-form stroke is migrated", () => {
  const [n] = migrate(docWith([{ id: "p-1", type: "connector", ...geom, ends, stroke: { color: "#ff0000", width: 2, dash: "dot" } }])).nodes;
  expect(n).toMatchObject({ stroke: { paint: { type: "solid", color: "#ff0000" }, width: 2, dash: "dot" } });
});
test.each([
  ["no ends", {}],
  ["one end", { ends: [ends[0]] }],
  ["a malformed end", { ends: [ends[0], { kind: "attached" }] }],
  ["a route that is not a string", { ends, route: 3 }],
  ["routeParams that are not an object", { ends, routeParams: [] }],
  ["a null stroke", { ends, stroke: null }],
  ["one cap", { ends, caps: [{ kind: "none", size: 3 }] }],
])("migrate rejects a malformed connector: %s", (_name, fields) => expect(() => migrate(docWith([{ id: "p-1", type: "connector", ...geom, ...fields }]))).toThrow(FormatError));

// --- adjustments
const withAdjustments = (value: string) => loadDocument(FILE.replace('"frame":null}', `"frame":null,"adjustments":${value}}`));
test("a file node with no adjustments parses to an empty list", () => expect((loadDocument(FILE).doc.nodes[0] as FileNode).adjustments).toEqual([]));
test("adjustments that are not a list of entries with a string type are a FormatError", () => {
  const message = 'Node p-3f9a: "adjustments" must be a list of { type, enabled, params }';
  for (const bad of ['"nope"', '[{"enabled":true}]', '[{"type":3}]', '[null]', '[{"type":"a","enabled":"yes"}]', '[{"type":"a","params":[]}]']) expect(() => withAdjustments(bad)).toThrow(new FormatError(message));
});
test("an adjustment with no enabled or params reads as enabled with empty params", () => expect((withAdjustments('[{"type":"x.future"}]').doc.nodes[0] as FileNode).adjustments).toEqual([{ type: "x.future", enabled: true, params: {} }]));

// --- strokes and paint
const withFrame = (value: string) => loadDocument(FILE.replace('"frame":null}', `"frame":${value}}`));
const frameOf = (loaded: ReturnType<typeof loadDocument>) => (loaded.doc.nodes[0] as FileNode).frame;
test("an old frame { color, opacity } loads as a solid paint, and is saved in the new form", () => {
  const loaded = withFrame('{"color":"#ff0000","width":1,"dash":"solid","opacity":0.5}');
  expect(frameOf(loaded)).toEqual({ paint: { type: "solid", color: "#ff0000", opacity: 0.5 }, width: 1, dash: "solid" });
  const out = serializeFigureFile(loaded.doc, loaded.parsed);
  const saved = JSON.parse(parseFigureFile(out).bodyJson!).nodes[0].frame;
  expect(saved).toEqual({ paint: { type: "solid", color: "#ff0000", opacity: 0.5 }, width: 1, dash: "solid" });
  expect(frameOf(loadDocument(out))).toEqual(frameOf(loaded));
});
test("an old frame keeps its cap and join, and one with no opacity gets none", () => {
  expect(frameOf(withFrame('{"color":"#000000","width":2,"dash":"dash","cap":"round","join":"round"}'))).toEqual({ paint: { type: "solid", color: "#000000" }, width: 2, dash: "dash", cap: "round", join: "round" });
});
test("a paint type this plugin does not know survives a round trip, extra keys and all", () => {
  const frame = { paint: { type: "x.future", amount: 3, nested: { a: [1, 2] } }, width: 1, dash: "dot", extra: true };
  const loaded = withFrame(JSON.stringify(frame));
  expect(frameOf(loaded)).toEqual(frame);
  expect(frameOf(loadDocument(serializeFigureFile(loaded.doc, loaded.parsed)))).toEqual(frame);
});
test("a stroke missing its width or dash gets 1 pt solid", () => expect(frameOf(withFrame('{"paint":{"type":"none"}}'))).toEqual({ paint: { type: "none" }, width: 1, dash: "solid" }));
test("a frame that is not a stroke is a FormatError", () => {
  const message = 'Node p-3f9a: "frame" must be null or a stroke { paint: { type, … }, width, dash }';
  for (const bad of ['"red"', "[]", '{"paint":"red"}', '{"paint":{"color":"#000000"}}', '{"color":3}']) expect(() => withFrame(bad)).toThrow(new FormatError(message));
});
test("an old frame with neither a paint nor a colour opens as solid black", () => {
  expect(frameOf(withFrame('{"width":2,"dash":"dot"}'))).toEqual({ paint: { type: "solid", color: "#000000" }, width: 2, dash: "dot" });
  expect(frameOf(withFrame("{}"))).toEqual({ paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" });
});
