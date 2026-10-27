import { applyLinkEntries, classifyReload } from "../../src/format/links-reload";
import { loadDocument } from "../../src/format/load";
import { parseFigureFile } from "../../src/format/parse";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import type { Document, FileNode } from "../../src/model/types";

/** A figure with two linked panels and a label, as the plugin would write it. */
function figure(): { doc: Document; text: string } {
  const doc = createDocument("nature-double");
  const [page] = doc.pages;
  const a = fileNodeDefaults(page, { file: "plot.png", subpath: "", show: "image" }, []);
  const b = fileNodeDefaults(page, { file: "analysis", subpath: "#Figure 2 legend", show: "content" }, [a.id]);
  const label = textNodeDefaults(page, { text: "A" }, [a.id, b.id]);
  doc.nodes.push(a, b, label);
  return { doc, text: serializeFigureFile(doc, { ...emptyParsed(), preamble: "Notes.\n" }) };
}

const file = (doc: Document, index: number): FileNode => doc.nodes[index] as FileNode;
const entries = (text: string) => parseFigureFile(text).links;

describe("applyLinkEntries", () => {
  test("changes only the nodes whose link differs, keeping every other node as the same object", () => {
    const { doc, text } = figure();
    const renamed = text.replace("![[plot.png]]", "![[plot2.png]]");
    const result = applyLinkEntries(doc, entries(renamed));
    expect(result.changedIds).toEqual([doc.nodes[0].id]);
    expect(file(result.doc, 0)).toMatchObject({ file: "plot2.png", subpath: "" });
    expect(result.doc.nodes[1]).toBe(doc.nodes[1]);
    expect(result.doc.nodes[2]).toBe(doc.nodes[2]);
    expect(result.doc.pages).toBe(doc.pages);
    // The document it was given is left alone.
    expect(file(doc, 0).file).toBe("plot.png");
  });

  test("splits the entry into file and subpath", () => {
    const { doc, text } = figure();
    const renamed = text.replace("![[analysis#Figure 2 legend]]", "![[analysis#Legend]]");
    const result = applyLinkEntries(doc, entries(renamed));
    expect(result.changedIds).toEqual([doc.nodes[1].id]);
    expect(file(result.doc, 1)).toMatchObject({ file: "analysis", subpath: "#Legend" });
  });

  test("a subpath alone changing counts, and so does a file alone changing", () => {
    const { doc, text } = figure();
    const both = text.replace("![[analysis#Figure 2 legend]]", "![[notes#Figure 2 legend]]").replace("![[plot.png]]", "![[plot.png#^blk]]");
    expect(applyLinkEntries(doc, entries(both)).changedIds.sort()).toEqual([doc.nodes[0].id, doc.nodes[1].id].sort());
  });

  test("nothing changed returns the very same document", () => {
    const { doc, text } = figure();
    const result = applyLinkEntries(doc, entries(text));
    expect(result.changedIds).toEqual([]);
    expect(result.doc).toBe(doc);
  });

  test("a file node whose entry is gone ends up with an empty link, as it does when the file is loaded", () => {
    const { doc, text } = figure();
    const without = text.replace(/- p-\w+: !\[\[plot\.png\]\] \^p-\w+\n/, "");
    const result = applyLinkEntries(doc, entries(without));
    expect(result.changedIds).toEqual([doc.nodes[0].id]);
    expect(file(result.doc, 0)).toMatchObject({ file: "", subpath: "" });
    expect(file(loadDocument(without).doc, 0)).toMatchObject({ file: "", subpath: "" });
  });

  test("entries for ids that are not in the document, and text nodes, are ignored", () => {
    const { doc } = figure();
    const result = applyLinkEntries(doc, [
      { id: "p-zzzz", linktext: "ghost.png" },
      { id: doc.nodes[2].id, linktext: "label.png" },
      { id: doc.nodes[0].id, linktext: "plot.png" },
      { id: doc.nodes[1].id, linktext: "analysis#Figure 2 legend" },
    ]);
    expect(result.changedIds).toEqual([]);
    expect(result.doc).toBe(doc);
  });

  test("agrees with what loading the same text would produce", () => {
    const { doc, text } = figure();
    const edited = text.replace("![[plot.png]]", "![[figs/plot2.png]]").replace("![[analysis#Figure 2 legend]]", "![[analysis#Legend]]");
    const viaReload = applyLinkEntries(doc, entries(edited)).doc;
    expect(viaReload).toEqual(loadDocument(edited).doc);
  });
});

describe("classifyReload", () => {
  const load = (text: string) => loadDocument(text);

  test("the same text is the same figure", () => {
    const { text } = figure();
    expect(classifyReload(load(text), load(text))).toBe("same");
  });

  test("a rewritten Links section is a links-only change", () => {
    const { text } = figure();
    const renamed = text.replace("![[plot.png]]", "![[plot2.png]]");
    expect(classifyReload(load(text), load(renamed))).toBe("links");
  });

  test("a link that came back (rename undone outside) is a links-only change too", () => {
    const { text } = figure();
    const renamed = text.replace("![[plot.png]]", "![[plot2.png]]");
    expect(classifyReload(load(renamed), load(text))).toBe("links");
  });

  test("entries that only moved around or lost their block ids are no change at all", () => {
    const { text } = figure();
    const [, links] = /## Links\n([\s\S]*?)\n## Figure/.exec(text)!;
    const lines = links.trim().split("\n");
    const shuffled = text.replace(links, [...lines].reverse().map((l) => l.replace(/ \^p-\w+$/, "")).join("\n") + "\n");
    expect(shuffled).not.toBe(text);
    expect(classifyReload(load(text), load(shuffled))).toBe("same");
  });

  test("hand-formatted JSON does not hide a links-only change", () => {
    const { text } = figure();
    const parsed = parseFigureFile(text);
    const minified = text.replace(parsed.bodyJson!, JSON.stringify(JSON.parse(parsed.bodyJson!))).replace("![[plot.png]]", "![[plot2.png]]");
    expect(minified).not.toBe(text);
    expect(classifyReload(load(text), load(minified))).toBe("links");
  });

  test("a change to the figure itself is something else", () => {
    const { doc, text } = figure();
    const moved = structuredClone(doc);
    moved.nodes[0].x = 123;
    const other = serializeFigureFile(moved, load(text).parsed);
    expect(classifyReload(load(text), load(other))).toBe("other");
    // Even together with a links change.
    expect(classifyReload(load(text), load(other.replace("![[plot.png]]", "![[plot2.png]]")))).toBe("other");
  });

  test("a changed label, page, node count, preamble or frontmatter is something else", () => {
    const { doc, text } = figure();
    const edit = (change: (d: Document) => void, parsedPatch: object = {}) => {
      const next = structuredClone(doc);
      change(next);
      return classifyReload(load(text), load(serializeFigureFile(next, { ...load(text).parsed, ...parsedPatch })));
    };
    expect(edit((d) => void ((d.nodes[2] as { text: string }).text = "B"))).toBe("other");
    expect(edit((d) => void (d.pages[0].paper = "#000000"))).toBe("other");
    expect(edit((d) => void d.nodes.pop())).toBe("other");
    expect(edit(() => {}, { preamble: "Other notes.\n" })).toBe("other");
    expect(edit(() => {}, { trailing: "Afterword.\n" })).toBe("other");
    expect(edit(() => {}, { frontmatter: "---\nlink-figures: 1\ntitle: t\n---\n" })).toBe("other");
  });

  test("a node that has no counterpart in the current figure is something else, even when its link is the only difference", () => {
    const { doc, text } = figure();
    const fewer = structuredClone(doc);
    fewer.nodes.splice(0, 1);
    expect(classifyReload(load(serializeFigureFile(fewer, load(text).parsed)), load(text))).toBe("other");
  });
});
