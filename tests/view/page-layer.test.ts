// @vitest-environment happy-dom
import { createDocument, createPage } from "../../src/model/defaults";
import type { Document } from "../../src/model/types";
import { PageLayer } from "../../src/view/page-layer";

function threePages(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  return doc;
}

describe("PageLayer tells before it moves or removes a page's element", () => {
  test("before a reorder and a removal, once each; not for a render that keeps every sheet where it is, nor for a page added at the end", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const told: string[] = [];
    const layer = new PageLayer(viewport, () => told.push("before"));
    const doc = threePages();
    layer.render(doc);
    // The first render only adds sheets.
    expect(told).toEqual([]);
    layer.render(doc);
    expect(told).toEqual([]);

    const reordered: Document = { ...doc, pages: [doc.pages[2], doc.pages[0], doc.pages[1]] };
    layer.render(reordered);
    expect(told).toEqual(["before"]);

    told.length = 0;
    const more: Document = { ...reordered, pages: [...reordered.pages, createPage("a4-portrait", reordered.pages.map((p) => p.id))] };
    layer.render(more);
    expect(told).toEqual([]);

    const fewer: Document = { ...more, pages: more.pages.slice(1) };
    layer.render(fewer);
    expect(told).toEqual(["before"]);
  });

  test("what is told runs while the sheets are still in their old places", () => {
    const viewport = document.createElement("div");
    const doc = threePages();
    let order: string[] = [];
    const layer = new PageLayer(viewport, () => {
      order = Array.from(viewport.children).map((el) => (el as HTMLElement).dataset.pageId ?? "");
    });
    layer.render(doc);
    const before = Array.from(viewport.children).map((el) => (el as HTMLElement).dataset.pageId ?? "");
    layer.render({ ...doc, pages: [doc.pages[1], doc.pages[0], doc.pages[2]] });
    expect(order).toEqual(before);
  });
});
