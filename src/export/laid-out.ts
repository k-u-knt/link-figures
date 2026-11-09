/** Where an element that has to be laid out but not seen is put while it is: far off screen. */
const OFF_SCREEN = "-100000px";

/**
 * Runs `work` with `el` laid out, and puts back what it changed afterwards. An element inside a `display: none`
 * ancestor has no layout, so a snapshot of it (snapdom measures it) is blank: this is so for a figure open in a tab
 * that is not shown, which is where an export opens a closed figure, and where any figure is once another tab of its
 * group is shown. Each such ancestor is shown for the duration, and the outermost is taken out of the flow and put off
 * screen at the window's size, so that nothing the user sees moves. An element already laid out is left as it is.
 */
export async function withLaidOut<T>(el: Element, work: () => Promise<T>): Promise<T> {
  const win = el.ownerDocument?.defaultView;
  if (!win) return work();
  const hidden: { el: HTMLElement; style: string | null }[] = [];
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at instanceof win.HTMLElement && win.getComputedStyle(at).display === "none") hidden.push({ el: at, style: at.getAttribute("style") });
  }
  if (hidden.length === 0) return work();
  try {
    for (const { el: at } of hidden) {
      // Obsidian hides a tab that is not shown with an inline `display: none`; a stylesheet's is overridden.
      if (at.style.display === "none") at.style.removeProperty("display");
      if (win.getComputedStyle(at).display === "none") at.style.setProperty("display", "block", "important");
    }
    const outer = hidden[hidden.length - 1].el.style;
    outer.setProperty("position", "fixed", "important");
    outer.setProperty("left", OFF_SCREEN, "important");
    outer.setProperty("top", "0", "important");
    outer.setProperty("width", "100vw", "important");
    outer.setProperty("height", "100vh", "important");
    return await work();
  } finally {
    for (const { el: at, style } of hidden) {
      if (style === null) at.removeAttribute("style");
      else at.setAttribute("style", style);
    }
  }
}
