import { isFigureText, parseFigureFile } from "../../src/format/parse";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import type { FileNode, TextNode } from "../../src/model/types";

const FILE = `---\nlink-figures: 1\ntitle: Fig 2\n---\n\nSome notes.\n\n## Links\n- p-3f9a: ![[analysis#^fig2b]] ^p-3f9a\n- p-8c21: ![[plots/plot.png]] ^p-8c21\n\n## Figure\n\`\`\`lnkfig\n{"version":1,"pages":[{"id":"pg-1","name":"Page 1","width":183,"height":170,"paper":"#ffffff","margins":{"top":0,"right":0,"bottom":0,"left":0},"grid":{"spacing":5,"show":false}}],"nodes":[{"id":"p-3f9a","type":"file","page":"pg-1","x":0,"y":0,"width":100,"height":50,"z":0,"rotation":0,"opacity":1,"locked":false,"show":"image","imageIndex":0,"crop":null,"fit":"cover","scale":1,"frame":null},{"id":"p-8c21","type":"file","page":"pg-1","x":0,"y":60,"width":100,"height":50,"z":1,"rotation":0,"opacity":1,"locked":false,"show":"image","imageIndex":0,"crop":null,"fit":"cover","scale":1,"frame":null}],"edges":[]}\n\`\`\`\nAfterword.\n`;
test("serialize(load(x)) preserves preamble, frontmatter keys and trailing text", () => { const { doc, parsed } = loadDocument(FILE); const out = serializeFigureFile(doc, parsed); expect(out.startsWith("---\nlink-figures: 1\ntitle: Fig 2\n---\n\nSome notes.\n\n## Links\n")).toBe(true); expect(out.endsWith("```\nAfterword.\n")).toBe(true); expect(loadDocument(out).doc).toEqual(doc); });
test("JSON on disk carries no file/subpath", () => { const { doc, parsed } = loadDocument(FILE); const out = serializeFigureFile(doc, parsed); const json = parseFigureFile(out).bodyJson!; expect(json).not.toMatch(/"file"\s*:/); expect(json).not.toContain('"subpath"'); for (const n of JSON.parse(json).nodes) expect(n).not.toHaveProperty("file"); });
test("links section is regenerated from nodes with block ids", () => { const { doc, parsed } = loadDocument(FILE); (doc.nodes[0] as FileNode).subpath = "#Results"; const out = serializeFigureFile(doc, parsed); expect(out).toContain("- p-3f9a: ![[analysis#Results]] ^p-3f9a\n"); });
test("a new document serialises with the marker", () => { const out = serializeFigureFile(createDocument("a4-portrait"), emptyParsed()); expect(isFigureText(out)).toBe(true); expect(loadDocument(out).doc.pages[0].width).toBe(210); });

// --- beyond the brief
test("serialising is idempotent once a file has been written by the plugin", () => { const { doc, parsed } = loadDocument(FILE); const once = serializeFigureFile(doc, parsed); const again = loadDocument(once); expect(serializeFigureFile(again.doc, again.parsed)).toBe(once); });
test("the Links section lists file nodes in node order and writes JSON with 2-space indent", () => { const { doc, parsed } = loadDocument(FILE); doc.nodes.reverse(); const out = serializeFigureFile(doc, parsed); expect(out.indexOf("- p-8c21:")).toBeLessThan(out.indexOf("- p-3f9a:")); expect(out).toContain('## Links\n- p-8c21: ![[plots/plot.png]] ^p-8c21\n- p-3f9a: ![[analysis#^fig2b]] ^p-3f9a\n\n## Figure\n```lnkfig\n{\n  "version": 1,'); });
test("text nodes round-trip with their font and have no link entry", () => {
  const doc = createDocument("nature-double");
  const text = textNodeDefaults(doc.pages[0], { text: "Hello", font: { family: "Georgia", size: 9, weight: "bold", italic: true, color: "#ff0000", align: "center", lineHeight: 1.5 } }, []);
  const file = fileNodeDefaults(doc.pages[0], { file: "notes/a b", subpath: "#^blk", show: "content" }, [text.id]);
  doc.nodes.push(text, file);
  const out = serializeFigureFile(doc, emptyParsed());
  expect(out).not.toContain(`- ${text.id}:`);
  expect(out).toContain(`- ${file.id}: ![[notes/a b#^blk]] ^${file.id}\n`);
  const back = loadDocument(out).doc;
  expect(back).toEqual(doc);
  expect((back.nodes[0] as TextNode).font.family).toBe("Georgia");
});
test("a node whose link is empty gets no Links entry", () => { const doc = createDocument("a4-portrait"); const n = fileNodeDefaults(doc.pages[0], { file: "", subpath: "", show: "image" }, []); doc.nodes.push(n); const out = serializeFigureFile(doc, emptyParsed()); expect(out).not.toContain("![[]]"); expect(parseFigureFile(out).links).toEqual([]); expect((loadDocument(out).doc.nodes[0] as FileNode).file).toBe(""); });
test("unknown keys survive a round trip", () => { const text = FILE.replace('"edges":[]', '"edges":[],"meta":{"k":1}').replace('"id":"p-3f9a","type":"file"', '"id":"p-3f9a","type":"file","name":"Panel b","color":"3"'); const { doc, parsed } = loadDocument(text); const back = loadDocument(serializeFigureFile(doc, parsed)).doc as unknown as Record<string, unknown>; expect(back.meta).toEqual({ k: 1 }); expect(back.nodes).toEqual(doc.nodes); expect((doc.nodes[0] as FileNode)).toMatchObject({ name: "Panel b", color: "3" }); });
test("a marker-only file keeps its extra frontmatter and body text when first saved", () => { const { doc, parsed } = loadDocument("---\nlink-figures: 1\nauthor: K\n---\nTODO: caption\n"); const out = serializeFigureFile(doc, parsed); expect(out.startsWith("---\nlink-figures: 1\nauthor: K\n---\nTODO: caption\n## Links\n\n## Figure\n```lnkfig\n")).toBe(true); expect(loadDocument(out).parsed.preamble).toBe("TODO: caption\n"); });
test("CRLF files are written back with LF endings and the same content", () => { const { doc, parsed } = loadDocument(FILE.replace(/\n/g, "\r\n")); const out = serializeFigureFile(doc, parsed); expect(out).not.toContain("\r"); expect(out.startsWith("---\nlink-figures: 1\ntitle: Fig 2\n---\n\nSome notes.\n\n## Links\n")).toBe(true); });
test("the marker is ensured in the frontmatter", () => {
  const doc = createDocument("a4-portrait");
  expect(serializeFigureFile(doc, { ...emptyParsed(), frontmatter: "---\nlink-figures: true\ntitle: t\n---\n" }).startsWith("---\nlink-figures: 1\ntitle: t\n---\n")).toBe(true);
  expect(serializeFigureFile(doc, { ...emptyParsed(), frontmatter: "---\ntitle: t\n---\n" }).startsWith("---\nlink-figures: 1\ntitle: t\n---\n")).toBe(true);
  expect(serializeFigureFile(doc, { ...emptyParsed(), frontmatter: "" }).startsWith("---\nlink-figures: 1\n---\n")).toBe(true);
});
test("a frontmatter whose closing fence ends the file is readable and written back with a newline", () => { const text = "---\nlink-figures: 1\n---"; expect(isFigureText(text)).toBe(true); const { doc, parsed } = loadDocument(text); expect(serializeFigureFile(doc, parsed).startsWith("---\nlink-figures: 1\n---\n## Links\n\n## Figure\n")).toBe(true); });
