/** Where an element that has to be laid out but not seen is put while it is: far off screen. */
const OFF_SCREEN = "-100000px";

/** An inline style property's value and priority ("important" or ""), as `getPropertyValue`/`getPropertyPriority` give them. */
interface Declared {
  value: string;
  priority: string;
}

/** What `withLaidOut` changed on one element, held while any call that needs it laid out is running. */
interface Hold {
  /** The calls that hold it; what was changed is put back when the last of them is done. */
  count: number;
  /** The style attribute before the first call changed it (null when there was none). */
  original: string | null;
  /** The style attribute once the calls had changed it: when it is still this, nothing else touched it. */
  applied: string | null;
  /** Each property set: what it was before, and what was set. */
  props: Map<string, { before: Declared; set: Declared }>;
}

/** The elements laid out at the moment, so that overlapping and nested calls share them (a per-element refcount). */
const holds = new WeakMap<HTMLElement, Hold>();

const declared = (el: HTMLElement, prop: string): Declared => ({ value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });

/** Sets `prop` to `value !important`, remembering `before` (what the inline style declared) to put back later. */
function setHeld(el: HTMLElement, hold: Hold, prop: string, value: string, before: Declared = declared(el, prop)): void {
  el.style.setProperty(prop, value, "important");
  if (!hold.props.has(prop)) hold.props.set(prop, { before, set: declared(el, prop) });
}

/**
 * Puts back what was changed on `el` once no call holds it. When nothing else touched its style meanwhile, the style
 * attribute is put back as it was, byte for byte. Otherwise each property set is put back only when it still has the
 * value set (so `display: none` comes back only if the display is still the one set here, and a tab that Obsidian showed
 * meanwhile stays shown), and the rest of the style is left as it now is.
 */
function release(el: HTMLElement): void {
  const hold = holds.get(el);
  if (!hold || --hold.count > 0) return;
  holds.delete(el);
  if (el.getAttribute("style") === hold.applied) {
    if (hold.original === null) el.removeAttribute("style");
    else el.setAttribute("style", hold.original);
    return;
  }
  for (const [prop, { before, set }] of hold.props) {
    const now = declared(el, prop);
    if (now.value !== set.value || now.priority !== set.priority) continue;
    if (before.value === "") el.style.removeProperty(prop);
    else el.style.setProperty(prop, before.value, before.priority);
  }
  if (hold.original === null && el.getAttribute("style") === "") el.removeAttribute("style");
}

/**
 * Runs `work` with `el` laid out, and puts back what it changed afterwards. An element inside a `display: none`
 * ancestor has no layout, so a snapshot of it (snapdom measures it) is blank: this is so for a figure open in a tab
 * that is not shown, which is where an export opens a closed figure, and where any figure is once another tab of its
 * group is shown. Each such ancestor is shown for the duration, and the outermost is taken out of the flow and put off
 * screen at the window's size, so that nothing the user sees moves. An element already laid out is left as it is.
 * Calls may overlap or nest: an element stays laid out until the last call that needs it is done (see `release`).
 */
export async function withLaidOut<T>(el: Element, work: () => Promise<T>): Promise<T> {
  const win = el.ownerDocument?.defaultView;
  if (!win) return work();
  const chain: HTMLElement[] = [];
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at instanceof win.HTMLElement && (holds.has(at) || win.getComputedStyle(at).display === "none")) chain.push(at);
  }
  if (chain.length === 0) return work();
  const taken: HTMLElement[] = [];
  try {
    const changed = new Set<HTMLElement>();
    for (const at of chain) {
      let hold = holds.get(at);
      if (!hold) {
        hold = { count: 0, original: at.getAttribute("style"), applied: null, props: new Map() };
        holds.set(at, hold);
        // Obsidian hides a tab that is not shown with an inline `display: none`; a stylesheet's is overridden. The
        // display set is the element's own (`flex`, say), marked important so that it is told apart from Obsidian's.
        const before = declared(at, "display");
        if (before.value === "none") at.style.removeProperty("display");
        const own = win.getComputedStyle(at).display;
        setHeld(at, hold, "display", own === "none" ? "block" : own, before);
        changed.add(at);
      }
      hold.count++;
      taken.push(at);
    }
    const outer = chain[chain.length - 1];
    const outerHold = holds.get(outer)!;
    if (!outerHold.props.has("position")) {
      setHeld(outer, outerHold, "position", "fixed");
      setHeld(outer, outerHold, "left", OFF_SCREEN);
      setHeld(outer, outerHold, "top", "0");
      setHeld(outer, outerHold, "width", "100vw");
      setHeld(outer, outerHold, "height", "100vh");
      changed.add(outer);
    }
    for (const at of changed) holds.get(at)!.applied = at.getAttribute("style");
    return await work();
  } finally {
    for (const at of taken) release(at);
  }
}
