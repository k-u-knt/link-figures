// @vitest-environment happy-dom
import { scrollsUnderWheel } from "../../src/view/wheel";

/** An element with the scroll metrics a laid-out one would have. */
function scroller(tag: string, m: { scrollTop?: number; scrollHeight: number; clientHeight: number; scrollLeft?: number; scrollWidth?: number; clientWidth?: number }, overflow = ""): HTMLElement {
  const el = document.createElement(tag);
  if (overflow) el.style.overflow = overflow;
  for (const [k, v] of Object.entries({ scrollTop: 0, scrollLeft: 0, scrollWidth: 100, clientWidth: 100, ...m })) Object.defineProperty(el, k, { value: v, configurable: true });
  return el;
}

describe("scrollsUnderWheel", () => {
  test("a textarea with more text below takes a wheel down; at its end the wheel goes to the canvas", () => {
    const stage = document.createElement("div");
    const area = scroller("textarea", { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
    stage.appendChild(area);
    expect(scrollsUnderWheel(area, stage, 0, 30)).toBe(true);
    // At the top it cannot scroll up.
    expect(scrollsUnderWheel(area, stage, 0, -30)).toBe(false);
    const atEnd = scroller("textarea", { scrollTop: 400, scrollHeight: 500, clientHeight: 100 });
    stage.appendChild(atEnd);
    expect(scrollsUnderWheel(atEnd, stage, 0, 30)).toBe(false);
    expect(scrollsUnderWheel(atEnd, stage, 0, -30)).toBe(true);
  });

  test("a sideways wheel goes by the width; a box that does not scroll (overflow hidden, or a plain div) never takes it", () => {
    const stage = document.createElement("div");
    const wide = scroller("textarea", { scrollHeight: 100, clientHeight: 100, scrollLeft: 0, scrollWidth: 400, clientWidth: 100 });
    stage.appendChild(wide);
    expect(scrollsUnderWheel(wide, stage, 20, 0)).toBe(true);
    const hidden = scroller("div", { scrollHeight: 500, clientHeight: 100 }, "hidden");
    const plain = scroller("div", { scrollHeight: 500, clientHeight: 100 });
    stage.append(hidden, plain);
    expect(scrollsUnderWheel(hidden, stage, 0, 30)).toBe(false);
    expect(scrollsUnderWheel(plain, stage, 0, 30)).toBe(false);
  });

  test("an element inside a scrolling box finds it; the search stops at the stage", () => {
    const stage = scroller("div", { scrollHeight: 900, clientHeight: 100 }, "auto");
    const box = scroller("div", { scrollHeight: 500, clientHeight: 100 }, "auto");
    const inner = document.createElement("span");
    box.appendChild(inner);
    stage.appendChild(box);
    expect(scrollsUnderWheel(inner, stage, 0, 30)).toBe(true);
    const loose = document.createElement("span");
    stage.appendChild(loose);
    expect(scrollsUnderWheel(loose, stage, 0, 30)).toBe(false);
    expect(scrollsUnderWheel(null, stage, 0, 30)).toBe(false);
  });
});
