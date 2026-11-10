import { CARD_PAPER_GAP_MM, paperRectsWorld, pushOffPaper, slideAlongPaper } from "../../src/model/card-space";
import { createDocument, createPage } from "../../src/model/defaults";
import { mmToPx, rectIntersects, type Rect } from "../../src/model/geometry";

const mm = (r: { x: number; y: number; width: number; height: number }): Rect => ({ x: mmToPx(r.x), y: mmToPx(r.y), width: mmToPx(r.width), height: mmToPx(r.height) });

function twoPages() {
  const doc = createDocument("a4-portrait");
  doc.pages.push(createPage("a4-portrait", doc.pages.map((p) => p.id)));
  return doc;
}

test("the gap is 4 mm, and each paper is inflated by it", () => {
  expect(CARD_PAPER_GAP_MM).toBe(4);
  const doc = twoPages();
  const papers = paperRectsWorld(doc);
  expect(papers).toHaveLength(2);
  const g = mmToPx(4);
  expect(papers[0]).toEqual({ x: -g, y: -g, width: mmToPx(210) + 2 * g, height: mmToPx(297) + 2 * g });
  // The second page starts 20 mm below the first.
  expect(papers[1].y).toBeCloseTo(mmToPx(297 + 20) - g, 6);
});

test("a rect over a page's paper is pushed out by the smallest move, 4 mm clear", () => {
  const doc = createDocument("a4-portrait");
  const papers = paperRectsWorld(doc);
  const out = pushOffPaper(mm({ x: 200, y: 100, width: 60, height: 40 }), papers);
  // Right is the shortest way out: to 4 mm beyond the right edge (210 mm).
  expect(out.x).toBeCloseTo(mmToPx(214), 6);
  expect(out.y).toBeCloseTo(mmToPx(100), 6);
  expect(out.width).toBeCloseTo(mmToPx(60), 6);
  for (const p of papers) expect(rectIntersects(out, p)).toBe(false);
  // A rect already clear is given back as it is.
  const clear = mm({ x: 220, y: 0, width: 60, height: 40 });
  expect(pushOffPaper(clear, papers)).toEqual(clear);
});

test("a rect between two pages clears both", () => {
  const papers = paperRectsWorld(twoPages());
  // Across the 20 mm gap between the pages, near their right edges: up hits page 1, down hits page 2.
  const out = pushOffPaper(mm({ x: 180, y: 290, width: 60, height: 40 }), papers);
  for (const p of papers) expect(rectIntersects(out, p)).toBe(false);
  expect(out.x).toBeCloseTo(mmToPx(214), 6);
  expect(out.y).toBeCloseTo(mmToPx(290), 6);
});

test("pushOffPaper keeps clear of every page when the nearest side lands on another", () => {
  const papers = paperRectsWorld(twoPages());
  // In the gap, near the left edges: no single side of one page clears both except going left.
  const out = pushOffPaper(mm({ x: 10, y: 300, width: 60, height: 12 }), papers);
  for (const p of papers) expect(rectIntersects(out, p)).toBe(false);
});

test("slideAlongPaper stops at the edge and keeps the tangential motion", () => {
  const papers = paperRectsWorld(createDocument("a4-portrait"));
  const from = mm({ x: 220, y: 100, width: 60, height: 40 });
  const to = mm({ x: 200, y: 130, width: 60, height: 40 });
  const out = slideAlongPaper(from, to, papers);
  expect(out.x).toBeCloseTo(mmToPx(214), 6);
  expect(out.y).toBeCloseTo(mmToPx(130), 6);
  // Motion that stays clear is taken whole.
  const free = mm({ x: 240, y: 10, width: 60, height: 40 });
  expect(slideAlongPaper(from, free, papers)).toEqual(free);
  // A fast drag does not tunnel through the paper to the other side.
  const far = mm({ x: -100, y: 100, width: 60, height: 40 });
  expect(slideAlongPaper(from, far, papers).x).toBeCloseTo(mmToPx(214), 6);
});
