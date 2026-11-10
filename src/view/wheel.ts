/**
 * Whether a wheel of (`dx`, `dy`) over `target` scrolls something inside `stage` rather than the canvas: an element
 * from `target` up to (not including) `stage` that scrolls (a textarea, such as a card's editor, or a box whose
 * overflow is `auto` or `scroll`) and has room left in the wheel's direction. At its end the wheel goes to the canvas.
 */
export function scrollsUnderWheel(target: EventTarget | null, stage: HTMLElement, dx: number, dy: number): boolean {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el !== stage) {
    if (scrolls(el) && hasRoom(el, dx, dy)) return true;
    el = el.parentElement;
  }
  return false;
}

function scrolls(el: HTMLElement): boolean {
  if (el.tagName === "TEXTAREA") return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return /\b(auto|scroll)\b/.test(`${style?.overflowX ?? ""} ${style?.overflowY ?? ""} ${el.style.overflow}`);
}

function hasRoom(el: HTMLElement, dx: number, dy: number): boolean {
  const down = dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  const up = dy < 0 && el.scrollTop > 0;
  const right = dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  const left = dx < 0 && el.scrollLeft > 0;
  return down || up || right || left;
}
