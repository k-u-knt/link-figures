import { drawingCommands } from "../../src/commands/drawing";
import { createDocument, shapeNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { Paint, ShapeNode } from "../../src/model/types";
import { shapeNodeType } from "../../src/nodes/shape-node";
import { builtinPaintTypes } from "../../src/paint/builtin";
import { builtinRampGeometries, builtinRampPresets } from "../../src/paint/ramp";
import { createRegistries } from "../../src/registry";
import { builtinShapeKinds } from "../../src/shapes/builtin";
import { Inspector } from "../../src/view/inspector";
import { DOUBLE_PRESS_MS, DROP_OFF_PX } from "../../src/view/ramp-slider";
import { readFileSync } from "node:fs";
import { SelectionState } from "../../src/view/selection";
import { pageInFocus } from "../../src/view/viewport";
import { obsidianWindow } from "../support/obsidian-dom";

/** The slider's track as laid out: 200 CSS px wide, its bottom edge at y 30. */
const TRACK = { left: 0, top: 0, width: 200, height: 30, right: 200, bottom: 30, x: 0, y: 0 };

const BLACK_WHITE: Paint = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };

/**
 * An inspector in a happy-dom window on one selected rectangle whose fill is `fill`, with the plugin's paints, ramp
 * geometries and presets registered, and the store's clock as the view wires it (a gesture's start while one lasts).
 */
function setup(fill: Paint, others: Paint[] = []) {
  const window = obsidianWindow();
  const document = window.document;
  const proto = window.HTMLElement.prototype as unknown as { getBoundingClientRect(): unknown };
  const measured = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList.contains("lf-ramp-track") ? TRACK : measured.call(this);
  };
  const doc = createDocument("a4-portrait");
  doc.nodes.push({ ...shapeNodeDefaults(doc.pages[0], { id: "p-shp" }, []), fill: structuredClone(fill) } as ShapeNode);
  others.forEach((other, i) => doc.nodes.push({ ...shapeNodeDefaults(doc.pages[0], { id: `p-${i}` }, doc.nodes.map((n) => n.id)), fill: structuredClone(other) } as ShapeNode));
  const registries = createRegistries();
  for (const t of builtinPaintTypes) registries.paints.register(t);
  for (const g of builtinRampGeometries) registries.rampGeometries.register(g);
  for (const p of builtinRampPresets) registries.rampPresets.register(p);
  for (const k of builtinShapeKinds) registries.shapes.register(k);
  registries.nodeTypes.register(shapeNodeType);
  for (const c of drawingCommands()) registries.commands.register(c);
  const clock = { now: Date.now() };
  const store = createFigureStore(doc, registries, () => view.gestureStartedAt ?? clock.now);
  const selection = new SelectionState();
  const view = {
    gestureStartedAt: null as number | null,
    readOnly: false,
    store,
    selection,
    plugin: { registries },
    focusPage: () => pageInFocus(store.doc, selection.ids, store.doc.pages[0])!,
    commandContext: () => ({ app: {} as never, registries, view, store, selection: selection.ids, page: view.focusPage() }),
  };
  // The listeners on the document, by type, so a test can see that none is left behind.
  const docListeners = new Map<string, Set<unknown>>();
  const add = document.addEventListener.bind(document) as (...args: unknown[]) => void;
  const remove = document.removeEventListener.bind(document) as (...args: unknown[]) => void;
  (document as unknown as { addEventListener: unknown }).addEventListener = (type: string, fn: never, opts?: never) => {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type)!.add(fn);
    add(type, fn, opts);
  };
  (document as unknown as { removeEventListener: unknown }).removeEventListener = (type: string, fn: never, opts?: never) => {
    docListeners.get(type)?.delete(fn);
    remove(type, fn, opts);
  };
  const listening = () => [...docListeners.entries()].filter(([, set]) => set.size > 0).map(([type]) => type);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const inspector = new Inspector(view as never, el as never);
  store.subscribe(() => inspector.render());
  selection.onChange(() => inspector.render());
  selection.set(doc.nodes.map((n) => n.id));
  const labels: string[] = [];
  store.subscribe((ev) => labels.push(ev.label));

  const holder = () => el.querySelector('[data-key="fill"]') as unknown as HTMLElement;
  const q = <T = HTMLElement>(selector: string) => holder().querySelector(selector) as unknown as T;
  const handles = () => Array.from(holder().querySelectorAll(".lf-ramp-handle")) as unknown as HTMLElement[];
  const fillNow = () => (store.doc.nodes[0] as ShapeNode).fill;
  const fills = () => store.doc.nodes.map((n) => (n as ShapeNode).fill);
  /** A pointer event; a press and a move have the primary button down (`buttons` 1) unless `buttons` says otherwise. */
  const pointer = (target: unknown, type: string, x: number, y = 10, buttons = type === "pointerup" ? 0 : 1) =>
    (target as EventTarget).dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1 }) as never);
  const key = (target: unknown, k: string, shiftKey = false) =>
    (target as EventTarget).dispatchEvent(new window.KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }) as never);
  const click = (target: unknown) => (target as EventTarget).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
  /** Drags handle `i` along the 200 px track through `xs`, then releases at the last one (at height `y`). */
  const drag = (i: number, xs: number[], y = 10) => {
    const handle = handles()[i];
    pointer(handle, "pointerdown", Number.parseFloat(handle.style.left) * 2, 20);
    for (const x of xs) pointer(q(".lf-ramp-track"), "pointermove", x, y);
    pointer(q(".lf-ramp-track"), "pointerup", xs[xs.length - 1] ?? 0, y);
  };
  return { window, document, el, store, selection, labels, fills, listening, holder, q, handles, fillNow, pointer, key, click, drag, kind: () => q(".lf-paint-kind").textContent };
}

describe("the paint control", () => {
  test("its select is None, Colour and Pattern, and a ramp paint of any kind is Colour", () => {
    for (const fill of [{ type: "solid", color: "#ff0000" }, BLACK_WHITE, { type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: [] }]) {
      const t = setup(fill);
      const select = t.q<HTMLSelectElement>('[data-key="fill.type"]');
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["None", "Colour", "Pattern"]);
      expect(select.value).toBe("@colour");
    }
  });

  test("choosing Colour on a paint of none writes a solid, and the slider shows it", () => {
    const t = setup({ type: "none" });
    expect(t.q(".lf-ramp")).toBeNull();
    const select = t.q<HTMLSelectElement>('[data-key="fill.type"]');
    select.value = "@colour";
    select.dispatchEvent(new t.window.Event("change") as never);
    expect(t.fillNow()).toEqual({ type: "solid", color: "#000000" });
    expect(t.kind()).toBe("Solid");
    expect(t.handles()).toHaveLength(1);
  });

  test("drawing the control writes nothing", () => {
    const t = setup(BLACK_WHITE);
    expect(t.labels).toEqual([]);
    expect(t.fillNow()).toEqual(BLACK_WHITE);
  });

  test("a handle per stop, focusable, as a slider with its value", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.25, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    const handles = t.handles();
    expect(handles.map((h) => h.getAttribute("role"))).toEqual(["slider", "slider", "slider"]);
    expect(handles.map((h) => h.getAttribute("tabindex"))).toEqual(["0", "0", "0"]);
    expect(handles.map((h) => h.getAttribute("aria-valuenow"))).toEqual(["0", "0.25", "1"]);
    expect(handles[1].style.left).toBe("25%");
    // The bar draws the ramp left to right.
    expect(t.q(".lf-ramp-fill").getAttribute("style")).toContain("linear-gradient(to right, rgba(0, 0, 0, 1) 0%, rgba(255, 0, 0, 1) 25%, rgba(255, 255, 255, 1) 100%)");
  });

  test("focusing a handle (as Tab does) selects it: its row shows its colour and offset", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.25, color: "#ff0000", opacity: 0.5 }, { offset: 1, color: "#ffffff" }] });
    t.handles()[1].focus();
    expect(t.handles()[1].classList.contains("lf-ramp-handle-selected")).toBe(true);
    expect(t.q<HTMLInputElement>('[data-key="fill.stop.color"]').value).toBe("#ff0000");
    expect(t.q<HTMLInputElement>('[data-key="fill.stop.opacity"]').value).toBe("0.5");
    expect(t.q<HTMLInputElement>('[data-key="fill.stop.offset"]').value).toBe("0.25");
    expect(t.labels).toEqual([]);
  });
});

describe("adding a stop", () => {
  test("a click on the bar adds a stop there in the ramp's colour, opacity included, and selects it", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000", opacity: 0 }, { offset: 1, color: "#ffffff" }] });
    t.pointer(t.q(".lf-ramp-bar"), "pointerdown", 100);
    expect(t.fillNow().stops).toEqual([{ offset: 0, color: "#000000", opacity: 0 }, { offset: 0.5, color: "#808080", opacity: 0.5 }, { offset: 1, color: "#ffffff" }]);
    expect(t.handles()[1].classList.contains("lf-ramp-handle-selected")).toBe(true);
    expect(t.labels).toEqual(["inspect:fill"]);
  });

  test("a solid that gains a stop is a linear gradient, and the label says so at once", () => {
    const t = setup({ type: "solid", color: "#ff0000" });
    expect(t.kind()).toBe("Solid");
    expect(t.q('[data-key="fill.angle"]')).toBeNull();
    t.pointer(t.q(".lf-ramp-bar"), "pointerdown", 150);
    expect(t.fillNow()).toEqual({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.75, color: "#ff0000" }] });
    expect(t.kind()).toBe("Linear gradient");
    expect(t.q<HTMLInputElement>('[data-key="fill.angle"]').value).toBe("0");
    // The new stop is the selected one.
    expect(t.q<HTMLInputElement>('[data-key="fill.stop.offset"]').value).toBe("0.75");
  });

  test("Add stop in the selected stop's row adds one half way to the next", () => {
    const t = setup(BLACK_WHITE);
    click(t, ".lf-stop-add");
    expect(t.fillNow().stops).toEqual([{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#808080" }, { offset: 1, color: "#ffffff" }]);
  });
});

/** Clicks the element `selector` finds in the fill's control. */
function click(t: ReturnType<typeof setup>, selector: string) {
  t.click(t.q(selector));
}

describe("dragging a handle", () => {
  test("moves its offset, and the whole drag is one undo step", () => {
    const t = setup(BLACK_WHITE);
    t.drag(0, [20, 40, 60]);
    expect(t.fillNow().stops).toEqual([{ offset: 0.3, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
    expect(t.labels).toEqual(["inspect:fill", "inspect:fill", "inspect:fill"]);
    expect(t.handles()[0].getAttribute("aria-valuenow")).toBe("0.3");
    t.store.undo();
    expect(t.fillNow()).toEqual(BLACK_WHITE);
  });

  test("a drag that rests between moves is still one step, and an edit after the release is its own", () => {
    const t = setup(BLACK_WHITE);
    t.drag(0, [20, 40]);
    t.click(t.q(".lf-ramp-reverse"));
    t.store.undo();
    expect(t.fillNow().stops).toEqual([{ offset: 0.2, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
    t.store.undo();
    expect(t.fillNow()).toEqual(BLACK_WHITE);
  });

  test("a drag past a neighbour swaps their order and keeps hold of the dragged stop", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    t.drag(0, [80, 150, 160]);
    expect(t.fillNow().stops).toEqual([{ offset: 0.5, color: "#ff0000" }, { offset: 0.8, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
    expect(t.handles()[1].classList.contains("lf-ramp-handle-selected")).toBe(true);
  });

  test("offsets are kept within 0 to 1", () => {
    const t = setup(BLACK_WHITE);
    t.drag(1, [260]);
    t.drag(0, [-50, 30]);
    expect(t.fillNow().stops).toEqual([{ offset: 0.15, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
  });
});

describe("removing a stop", () => {
  test("a handle pulled more than 24 px below the slider is removed on release, in the drag's one undo step", () => {
    const three: Paint = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] };
    const t = setup(three);
    const handle = t.handles()[1];
    t.pointer(handle, "pointerdown", 100, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 100, TRACK.bottom + DROP_OFF_PX + 1);
    // Marked while it is off, not yet removed.
    expect(t.handles()[1].classList.contains("lf-ramp-handle-off")).toBe(true);
    expect(t.fillNow().stops).toHaveLength(3);
    t.pointer(t.q(".lf-ramp-track"), "pointerup", 100, TRACK.bottom + DROP_OFF_PX + 1);
    expect(t.fillNow().stops).toEqual([{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
    expect(t.labels).toEqual(["inspect:fill"]);
    t.store.undo();
    expect(t.fillNow()).toEqual(three);
  });

  test("a handle brought back onto the slider before the release stays", () => {
    const t = setup(BLACK_WHITE);
    t.pointer(t.handles()[1], "pointerdown", 200, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 200, 80);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 200, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointerup", 200, 20);
    expect(t.fillNow()).toEqual(BLACK_WHITE);
  });

  test("down to one stop is a solid, and the label says so; the last stop cannot be pulled off", () => {
    const t = setup(BLACK_WHITE);
    t.drag(0, [0], 80);
    expect(t.fillNow()).toEqual({ type: "solid", color: "#ffffff" });
    expect(t.kind()).toBe("Solid");
    t.drag(0, [0], 80);
    expect(t.fillNow()).toEqual({ type: "solid", color: "#ffffff" });
  });

  test("Delete or Backspace removes the selected stop, and the focus stays on a handle", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    t.handles()[1].focus();
    t.key(t.handles()[1], "Delete");
    expect(t.fillNow().stops).toEqual([{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
    expect(t.document.activeElement?.getAttribute("role")).toBe("slider");
    t.key(t.document.activeElement!, "Backspace");
    expect(t.fillNow().type).toBe("solid");
    expect(t.kind()).toBe("Solid");
    expect(t.document.activeElement?.getAttribute("role")).toBe("slider");
    // The last stop stays.
    t.key(t.document.activeElement!, "Delete");
    expect(t.fillNow().type).toBe("solid");
  });

  test("Remove in the selected stop's row removes it; it is disabled for the last stop", () => {
    const t = setup(BLACK_WHITE);
    click(t, ".lf-stop-remove");
    expect(t.fillNow()).toEqual({ type: "solid", color: "#ffffff" });
    expect(t.q<HTMLButtonElement>(".lf-stop-remove").disabled).toBe(true);
  });
});

describe("the keyboard", () => {
  test("arrow keys move the selected handle by 0.01, with Shift by 0.1, and the focus stays on it", () => {
    const t = setup(BLACK_WHITE);
    t.handles()[0].focus();
    t.key(t.handles()[0], "ArrowRight");
    expect(t.fillNow().stops).toEqual([{ offset: 0.01, color: "#000000" }, { offset: 1, color: "#ffffff" }]);
    t.key(t.document.activeElement!, "ArrowRight", true);
    expect((t.fillNow().stops as { offset: number }[])[0].offset).toBe(0.11);
    t.key(t.document.activeElement!, "ArrowLeft");
    expect((t.fillNow().stops as { offset: number }[])[0].offset).toBe(0.1);
    expect(t.document.activeElement).toBe(t.handles()[0]);
    expect(t.handles()[0].getAttribute("aria-valuenow")).toBe("0.1");
    // Home and End take it to the ends; it never goes below 0.
    t.key(t.document.activeElement!, "Home");
    t.key(t.document.activeElement!, "ArrowLeft");
    expect((t.fillNow().stops as { offset: number }[])[0].offset).toBe(0);
  });

  test("an arrow that takes a handle past its neighbour keeps the focus on the moved stop", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 0.505, color: "#ffffff" }] });
    t.handles()[1].focus();
    t.key(t.handles()[1], "ArrowRight");
    expect((t.fillNow().stops as { color: string }[]).map((s) => s.color)).toEqual(["#000000", "#ffffff", "#ff0000"]);
    expect(t.document.activeElement).toBe(t.handles()[2]);
  });
});

describe("Reverse, the geometry and the presets", () => {
  test("Reverse flips the ramp", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.25, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    t.click(t.q(".lf-ramp-reverse"));
    expect(t.fillNow().stops).toEqual([{ offset: 0, color: "#ffffff" }, { offset: 0.75, color: "#ff0000" }, { offset: 1, color: "#000000" }]);
    expect(t.labels).toEqual(["inspect:fill"]);
  });

  test("the geometry toggle shows for a gradient only, switches it and keeps the stops", () => {
    const solid = setup({ type: "solid", color: "#ff0000" });
    expect(solid.holder().querySelectorAll(".lf-ramp-geometry-option")).toHaveLength(0);

    const t = setup(BLACK_WHITE);
    const options = () => Array.from(t.holder().querySelectorAll(".lf-ramp-geometry-option")) as unknown as HTMLElement[];
    expect(options().map((o) => [o.textContent, o.getAttribute("aria-pressed")])).toEqual([["Linear", "true"], ["Radial", "false"]]);
    t.click(options()[1]);
    expect(t.fillNow()).toEqual({ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: BLACK_WHITE.stops });
    expect(t.kind()).toBe("Radial gradient");
    expect(t.q('[data-key="fill.angle"]')).toBeNull();
    expect(t.q<HTMLInputElement>('[data-key="fill.cx"]').value).toBe("0.5");
    expect(options().map((o) => o.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    t.click(options()[0]);
    expect(t.fillNow()).toEqual(BLACK_WHITE);
  });

  test("the presets menu lists Solid, Two-colour linear, Radial and Reverse, and an entry writes its ramp", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }] });
    const button = t.q(".lf-ramp-presets-button");
    t.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = () => Array.from(t.holder().querySelectorAll(".lf-ramp-preset")) as unknown as HTMLElement[];
    expect(items().map((i) => i.textContent)).toEqual(["Solid", "Two-colour linear", "Radial", "Reverse"]);
    expect(items().map((i) => i.getAttribute("role"))).toEqual(["menuitem", "menuitem", "menuitem", "menuitem"]);
    t.click(items()[1]);
    expect(t.fillNow()).toEqual({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] });
    expect(t.holder().querySelector(".lf-ramp-presets")).toBeNull();

    // Solid keeps the selected stop's colour.
    t.handles()[1].focus();
    t.click(t.q(".lf-ramp-presets-button"));
    t.click(items()[0]);
    expect(t.fillNow()).toEqual({ type: "solid", color: "#0000ff" });
    expect(t.kind()).toBe("Solid");

    // Radial from a solid: black to white.
    t.click(t.q(".lf-ramp-presets-button"));
    t.click(items()[2]);
    expect(t.fillNow()).toEqual({ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: BLACK_WHITE.stops });
  });

  test("Escape closes the presets menu", () => {
    const t = setup(BLACK_WHITE);
    t.click(t.q(".lf-ramp-presets-button"));
    t.key(t.q(".lf-ramp-preset"), "Escape");
    expect(t.holder().querySelector(".lf-ramp-presets")).toBeNull();
    expect(t.document.activeElement).toBe(t.q(".lf-ramp-presets-button"));
  });
});

describe("the kind label", () => {
  test("follows the slider in the same sync as each write: Solid, Linear gradient, Radial gradient", () => {
    const t = setup({ type: "solid", color: "#ff0000" });
    const seen = [t.kind()];
    t.pointer(t.q(".lf-ramp-bar"), "pointerdown", 100);
    seen.push(t.kind());
    t.click(t.holder().querySelectorAll(".lf-ramp-geometry-option")[1] as unknown as HTMLElement);
    seen.push(t.kind());
    expect(seen).toEqual(["Solid", "Linear gradient", "Radial gradient"]);
    // And back on undo.
    t.store.undo();
    expect(t.kind()).toBe("Linear gradient");
    t.store.undo();
    expect(t.kind()).toBe("Solid");
  });
});

describe("the selected stop's row", () => {
  test("its colour, opacity and offset write the stop", () => {
    const t = setup(BLACK_WHITE);
    t.handles()[1].focus();
    const color = t.q<HTMLInputElement>('[data-key="fill.stop.color"]');
    color.value = "#336699";
    color.dispatchEvent(new t.window.Event("input") as never);
    const opacity = t.q<HTMLInputElement>('[data-key="fill.stop.opacity"]');
    opacity.value = "0.4";
    opacity.dispatchEvent(new t.window.Event("change") as never);
    const offset = t.q<HTMLInputElement>('[data-key="fill.stop.offset"]');
    offset.value = "0.6";
    offset.dispatchEvent(new t.window.Event("change") as never);
    expect(t.fillNow().stops).toEqual([{ offset: 0, color: "#000000" }, { offset: 0.6, color: "#336699", opacity: 0.4 }]);
  });

  test("a solid's row has no offset, and its colour and opacity write the solid", () => {
    const t = setup({ type: "solid", color: "#ff0000" });
    expect(t.q('[data-key="fill.stop.offset"]')).toBeNull();
    const opacity = t.q<HTMLInputElement>('[data-key="fill.stop.opacity"]');
    expect(opacity.value).toBe("1");
    opacity.value = "0.5";
    opacity.dispatchEvent(new t.window.Event("change") as never);
    expect(t.fillNow()).toEqual({ type: "solid", color: "#ff0000", opacity: 0.5 });
  });
});

describe("writes that drop a key", () => {
  test("a solid's opacity set back to 1 is gone from the paint, not left at its old value by a merge", () => {
    const t = setup({ type: "solid", color: "#ff0000", opacity: 0.5 });
    const opacity = t.q<HTMLInputElement>('[data-key="fill.stop.opacity"]');
    opacity.value = "1";
    opacity.dispatchEvent(new t.window.Event("change") as never);
    expect(t.fillNow()).toEqual({ type: "solid", color: "#ff0000" });
  });

  test("a stop's opacity set back to 1 is kept as written", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000", opacity: 0.5 }, { offset: 1, color: "#ffffff" }] });
    const opacity = t.q<HTMLInputElement>('[data-key="fill.stop.opacity"]');
    opacity.value = "1";
    opacity.dispatchEvent(new t.window.Event("change") as never);
    expect((t.fillNow().stops as unknown[])[0]).toEqual({ offset: 0, color: "#000000", opacity: 1 });
  });
});

describe("several items selected", () => {
  const setOpacity = (t: ReturnType<typeof setup>, value: string) => {
    const opacity = t.q<HTMLInputElement>('[data-key="fill.stop.opacity"]');
    opacity.value = value;
    opacity.dispatchEvent(new t.window.Event("change") as never);
  };

  test("paints of different types read Mixed; the bar shows the first; an edit writes that paint to all and the label follows", () => {
    const t = setup({ type: "solid", color: "#ff0000" }, [BLACK_WHITE]);
    expect(t.kind()).toBe("Mixed");
    expect(t.handles()).toHaveLength(1);
    expect(t.q<HTMLInputElement>('[data-key="fill.stop.color"]').value).toBe("#ff0000");
    expect(t.labels).toEqual([]);
    setOpacity(t, "0.5");
    expect(t.fills()).toEqual([{ type: "solid", color: "#ff0000", opacity: 0.5 }, { type: "solid", color: "#ff0000", opacity: 0.5 }]);
    expect(t.kind()).toBe("Solid");
    expect(t.labels).toEqual(["inspect:fill"]);
  });

  test("paints of one type with different values read Mixed, and an edit makes them the same", () => {
    const t = setup({ type: "solid", color: "#ff0000" }, [{ type: "solid", color: "#0000ff", opacity: 0.25 }]);
    expect(t.kind()).toBe("Mixed");
    t.pointer(t.q(".lf-ramp-bar"), "pointerdown", 100);
    const expected = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#ff0000" }] };
    expect(t.fills()).toEqual([expected, expected]);
    expect(t.kind()).toBe("Linear gradient");
  });

  test("equal paints read their kind, and an edit goes to all of them", () => {
    const t = setup(BLACK_WHITE, [BLACK_WHITE]);
    expect(t.kind()).toBe("Linear gradient");
    t.click(t.q(".lf-ramp-reverse"));
    const reversed = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] };
    expect(t.fills()).toEqual([reversed, reversed]);
    expect(t.kind()).toBe("Linear gradient");
  });
});

describe("the presets menu", () => {
  test("closes on a press outside it, and stays open for a press inside it", () => {
    const t = setup(BLACK_WHITE);
    t.click(t.q(".lf-ramp-presets-button"));
    t.pointer(t.q(".lf-ramp-preset"), "pointerdown", 0);
    expect(t.holder().querySelector(".lf-ramp-presets")).not.toBeNull();
    t.pointer(t.document.body, "pointerdown", 0);
    expect(t.holder().querySelector(".lf-ramp-presets")).toBeNull();
    expect(t.q(".lf-ramp-presets-button").getAttribute("aria-expanded")).toBe("false");
    // A press on the bar while it is open closes it too (and adds a stop, as any press there does).
    t.click(t.q(".lf-ramp-presets-button"));
    t.pointer(t.q(".lf-ramp-bar"), "pointerdown", 100);
    expect(t.holder().querySelector(".lf-ramp-presets")).toBeNull();
  });
});

describe("review fixes", () => {
  test("a mixed pair, one with an opacity and one without, is exactly one paint after an edit, and no longer Mixed", () => {
    const t = setup({ type: "solid", color: "#ff0000" }, [{ type: "solid", color: "#0000ff", opacity: 0.5 }]);
    expect(t.kind()).toBe("Mixed");
    const color = t.q<HTMLInputElement>('[data-key="fill.stop.color"]');
    color.value = "#00aa00";
    color.dispatchEvent(new t.window.Event("input") as never);
    expect(t.fills()).toEqual([{ type: "solid", color: "#00aa00" }, { type: "solid", color: "#00aa00" }]);
    expect(t.kind()).toBe("Solid");
  });

  test("the other way round: the first has the opacity, and the second gains it", () => {
    const t = setup({ type: "solid", color: "#0000ff", opacity: 0.5 }, [{ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }], note: 1 }]);
    t.click(t.q(".lf-ramp-reverse"));
    expect(t.fills()).toEqual([{ type: "solid", color: "#0000ff", opacity: 0.5 }, { type: "solid", color: "#0000ff", opacity: 0.5 }]);
    expect(t.kind()).toBe("Solid");
  });

  test("Escape during a drag puts the ramp back as it was and leaves no undo step", () => {
    const t = setup(BLACK_WHITE);
    const handle = t.handles()[0];
    t.pointer(handle, "pointerdown", 0, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 40);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 80);
    expect((t.fillNow().stops as { offset: number }[])[0].offset).toBe(0.4);
    t.key(t.document, "Escape");
    expect(t.fillNow()).toEqual(BLACK_WHITE);
    expect(t.store.canUndo()).toBe(false);
    expect(t.store.canRedo()).toBe(false);
    // The drag is over: a later move writes nothing, and its listeners are gone.
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 120);
    t.pointer(t.q(".lf-ramp-track"), "pointerup", 120);
    expect(t.fillNow()).toEqual(BLACK_WHITE);
    expect(t.listening()).toEqual([]);
  });

  test("Escape during a drag keeps the edits made before it", () => {
    const t = setup(BLACK_WHITE);
    t.click(t.q(".lf-ramp-reverse"));
    const reversed = t.fillNow();
    t.drag(0, [40]);
    t.pointer(t.handles()[0], "pointerdown", 40, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 100);
    t.key(t.document, "Escape");
    expect((t.fillNow().stops as { offset: number }[])[0].offset).toBe(0.2);
    t.store.undo();
    expect(t.fillNow()).toEqual(reversed);
  });

  test("the one handle of a solid is selected by a press, and moving it writes nothing", () => {
    const t = setup({ type: "solid", color: "#ff0000" });
    t.drag(0, [60, 120], 10);
    expect(t.labels).toEqual([]);
    expect(t.fillNow()).toEqual({ type: "solid", color: "#ff0000" });
    expect(t.handles()[0].classList.contains("lf-ramp-handle-selected")).toBe(true);
  });

  test("a move with no button down (a release the slider never saw) ends the drag", () => {
    const t = setup(BLACK_WHITE);
    t.pointer(t.handles()[0], "pointerdown", 0, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 40);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 80, 10, 0);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 120);
    expect((t.fillNow().stops as { offset: number }[])[0].offset).toBe(0.2);
    expect(t.labels).toEqual(["inspect:fill"]);
    expect(t.listening()).toEqual([]);
  });

  test("a drag under way when the control is drawn again releases its pointer capture, and keeps what it wrote", () => {
    const t = setup(BLACK_WHITE);
    const track = t.q(".lf-ramp-track") as HTMLElement & { setPointerCapture(id: number): void; releasePointerCapture(id: number): void };
    const released: number[] = [];
    const captured: number[] = [];
    track.setPointerCapture = (id: number) => void captured.push(id);
    track.releasePointerCapture = (id: number) => void released.push(id);
    (track as unknown as { hasPointerCapture(id: number): boolean }).hasPointerCapture = (id: number) => captured.includes(id) && !released.includes(id);
    t.pointer(t.handles()[0], "pointerdown", 0, 20);
    t.pointer(track, "pointermove", 40);
    expect(captured).toEqual([1]);
    t.store.commit("paint", (d) => { (d.nodes[0] as ShapeNode).fill = { type: "solid", color: "#ff0000" }; });
    expect(released).toEqual([1]);
    expect(t.listening()).toEqual([]);
  });

  test("an open presets menu's listener goes when the control is drawn again, and when the inspector is emptied", () => {
    const t = setup(BLACK_WHITE);
    t.click(t.q(".lf-ramp-presets-button"));
    expect(t.listening()).toEqual(["pointerdown"]);
    // Another kind of paint from elsewhere: the control is drawn again.
    t.store.commit("paint", (d) => { (d.nodes[0] as ShapeNode).fill = { type: "solid", color: "#ff0000" }; });
    expect(t.listening()).toEqual([]);
    t.click(t.q(".lf-ramp-presets-button"));
    expect(t.listening()).toEqual(["pointerdown"]);
    t.selection.set([]);
    expect(t.listening()).toEqual([]);
  });
});

describe("in-app findings", () => {
  /** Counts the opening of the selected stop's colour picker (a click on its colour input). */
  const pickerOpens = (t: ReturnType<typeof setup>) => {
    let opened = 0;
    t.holder().addEventListener("click", (e) => {
      if ((e.target as HTMLElement).getAttribute?.("data-key") === "fill.stop.color") opened++;
    });
    return () => opened;
  };
  const press = (t: ReturnType<typeof setup>, i: number, dx = 0) => {
    const h = t.handles()[i];
    const x = Number.parseFloat(h.style.left) * 2 + dx;
    t.pointer(h, "pointerdown", x, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointerup", x, 20);
  };

  test("two presses on one handle within 400 ms and 4 px, with no drag between, open its colour picker", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    const opens = pickerOpens(t);
    press(t, 1);
    press(t, 1, 3);
    expect(opens()).toBe(1);
    expect(t.q<HTMLInputElement>('[data-key="fill.stop.color"]').value).toBe("#ff0000");
    expect(t.labels).toEqual([]);
    // A third press is a new first press.
    press(t, 1);
    expect(opens()).toBe(1);
  });

  test("presses too far apart in time or space, on two handles, or with a drag between, do not", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    const opens = pickerOpens(t);
    const now = vi.spyOn(Date, "now");
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    press(t, 1);
    clock += DOUBLE_PRESS_MS + 1;
    press(t, 1);
    clock += 10;
    press(t, 1, 5);
    clock += 10;
    press(t, 0);
    clock += 10;
    press(t, 1);
    now.mockRestore();
    t.drag(1, [110]);
    press(t, 1);
    expect(opens()).toBe(0);
  });

  test("a typed Offset equal to a neighbour's, committed with Enter (and the change that follows), is exactly one undo step", () => {
    const t = setup(BLACK_WHITE);
    t.handles()[1].focus();
    const offset = t.q<HTMLInputElement>('[data-key="fill.stop.offset"]');
    offset.focus();
    offset.value = "0";
    offset.dispatchEvent(new t.window.Event("input") as never);
    offset.dispatchEvent(new t.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as never);
    // What a browser may still send for the same edit: a change, on the input that was there, and on the one there now.
    offset.dispatchEvent(new t.window.Event("change") as never);
    const now = t.q<HTMLInputElement>('[data-key="fill.stop.offset"]');
    now.dispatchEvent(new t.window.Event("change") as never);
    now.dispatchEvent(new t.window.Event("blur") as never);
    expect(t.labels).toEqual(["inspect:fill"]);
    expect((t.fillNow().stops as { color: string; offset: number }[]).map((s) => [s.color, s.offset])).toEqual([["#ffffff", 0], ["#000000", 0]]);
    t.store.undo();
    expect(t.fillNow()).toEqual(BLACK_WHITE);
    expect(t.store.canUndo()).toBe(false);
  });

  test("a press on the bar within 8 px of a handle takes that handle (selects and drags it); only one clearly away adds a stop", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    const bar = t.q(".lf-ramp-bar");
    t.pointer(bar, "pointerdown", 107);
    expect(t.handles()[1].classList.contains("lf-ramp-handle-selected")).toBe(true);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 120);
    t.pointer(t.q(".lf-ramp-track"), "pointerup", 120);
    expect((t.fillNow().stops as unknown[]).length).toBe(3);
    expect((t.fillNow().stops as { offset: number }[])[1].offset).toBe(0.6);
    t.pointer(bar, "pointerdown", 160);
    t.pointer(t.q(".lf-ramp-track"), "pointerup", 160);
    expect((t.fillNow().stops as unknown[]).length).toBe(4);
  });

  test("a handle's hit area is at least 20 px, and it says what it does", () => {
    const t = setup(BLACK_WHITE);
    expect(t.handles()[0].getAttribute("title")).toBe("Drag to move · double-click for colour · drag down or Delete to remove");
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    const style = t.document.createElement("style");
    style.textContent = css;
    t.document.head.appendChild(style);
    const after = (t.window.getComputedStyle as unknown as (el: unknown, pseudo: string) => { width: string })(t.handles()[0], "::after");
    const hit = Number.parseFloat(after.width) || 0;
    // The ::after rule may not compute in happy-dom: then read the rule itself.
    const rule = /\.lf-ramp-handle::after\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    const inset = Number.parseFloat(/inset:\s*-(\d+(?:\.\d+)?)px/.exec(rule)?.[1] ?? "0");
    expect(Math.max(hit, 12 + 2 * 2 + 2 * inset)).toBeGreaterThanOrEqual(20);
  });

  test("stacked stops: a press on the stack selects the next one in turn, and the selected one is drawn on top", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0.5, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 0.5, color: "#0000ff" }, { offset: 1, color: "#ffffff" }] });
    const selectedColor = () => t.q<HTMLInputElement>('[data-key="fill.stop.color"]').value;
    const now = vi.spyOn(Date, "now");
    let clock = 1_000_000;
    now.mockImplementation(() => (clock += 1000));
    const seen: string[] = [];
    for (let k = 0; k < 4; k++) {
      const top = t.handles().find((h) => h.classList.contains("lf-ramp-handle-selected") && h.style.left === "50%") ?? t.handles()[0];
      t.pointer(top, "pointerdown", 100, 20);
      t.pointer(t.q(".lf-ramp-track"), "pointerup", 100, 20);
      seen.push(selectedColor());
    }
    now.mockRestore();
    expect(seen).toEqual(["#00ff00", "#0000ff", "#ff0000", "#00ff00"]);
    expect(t.labels).toEqual([]);
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(/\.lf-ramp-handle\.lf-ramp-handle-selected\s*{[^}]*z-index:\s*[1-9]/.test(css)).toBe(true);
  });

  test("a handle pulled past the threshold shows a ×, the remove cursor and \"Release to remove\"; brought back, none of them", () => {
    const t = setup({ type: "linear", angle: 0, stops: [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    t.pointer(t.handles()[1], "pointerdown", 100, 20);
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 100, TRACK.bottom + DROP_OFF_PX + 1);
    expect(t.handles()[1].textContent).toBe("×");
    expect(t.q(".lf-ramp-track").classList.contains("lf-ramp-removing")).toBe(true);
    expect(t.q(".lf-ramp-status").textContent).toBe("Release to remove");
    t.pointer(t.q(".lf-ramp-track"), "pointermove", 100, 20);
    expect(t.handles()[1].textContent).toBe("");
    expect(t.q(".lf-ramp-track").classList.contains("lf-ramp-removing")).toBe(false);
    expect(t.q(".lf-ramp-status").textContent).toBe("");
    t.pointer(t.q(".lf-ramp-track"), "pointerup", 100, 20);
  });

  test("the kind label keeps its full text in its title", () => {
    const t = setup({ type: "solid", color: "#ff0000" });
    expect(t.q(".lf-paint-kind").getAttribute("title")).toBe("Solid");
    t.pointer(t.q(".lf-ramp-bar"), "pointerdown", 150);
    expect(t.q(".lf-paint-kind").getAttribute("title")).toBe("Linear gradient");
  });

  test("the presets menu opens in the flow under the slider's top row, above the bar, never over it", () => {
    const t = setup(BLACK_WHITE);
    t.click(t.q(".lf-ramp-presets-button"));
    const menu = t.q(".lf-ramp-presets");
    const track = t.q(".lf-ramp-track");
    // In document order: the head, the menu, then the bar and handles.
    expect(menu.compareDocumentPosition(track as never) & 4).toBeTruthy();
    expect(t.q(".lf-ramp-head").compareDocumentPosition(menu as never) & 4).toBeTruthy();
  });

  test("the slider's styles: the label does not wrap, the menu is not laid over the slider, and rows wrap at narrow widths", () => {
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|\\n)${escaped}\\s*{([^}]*)}`).exec(css)?.[2] ?? "";
    };
    expect(rule(".lf-paint-kind")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".lf-paint-kind")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".lf-paint-kind")).toMatch(/overflow:\s*hidden/);
    expect(rule(".lf-paint-kind")).toMatch(/min-width:\s*0/);
    expect(rule(".lf-ramp-presets")).not.toMatch(/position:\s*absolute/);
    expect(rule(".lf-ramp-head")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".lf-ramp-geometry")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".lf-ramp-stop-buttons")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".lf-ramp-presets")).toMatch(/flex-wrap:\s*wrap/);
  });

  test("the check 18 sequence leaves every border, and every other field than the fill, as it was", () => {
    const t = setup({ type: "solid", color: "#ff0000" }, [{ type: "solid", color: "#0000ff", opacity: 0.5 }, BLACK_WHITE]);
    const rest = () => t.store.doc.nodes.map((n) => ({ ...(n as ShapeNode), fill: null }));
    const before = rest();
    const opacity = t.q<HTMLInputElement>('[data-key="fill.stop.opacity"]');
    opacity.value = "0.4";
    opacity.dispatchEvent(new t.window.Event("change") as never);
    t.store.undo();
    t.click(t.q(".lf-ramp-reverse"));
    t.click(t.q(".lf-ramp-presets-button"));
    t.click(t.q(".lf-ramp-preset"));
    t.pointer(t.q(".lf-ramp-bar"), "pointerdown", 150);
    const select = t.q<HTMLSelectElement>('[data-key="fill.type"]');
    select.value = "pattern";
    select.dispatchEvent(new t.window.Event("change") as never);
    t.store.undo();
    t.store.undo();
    expect(rest()).toEqual(before);
    expect(t.labels.filter((l) => l !== "inspect:fill")).toEqual([]);
  });
});

describe("in-app re-check", () => {
  test("each click on a stack of stops advances exactly one, with the browser's own press, focus, release and click", () => {
    const stack: Paint = { type: "linear", angle: 0, stops: [{ offset: 0.5, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 0.5, color: "#0000ff" }, { offset: 1, color: "#ffffff" }] };
    const t = setup(stack);
    const selected = () => t.q<HTMLInputElement>('[data-key="fill.stop.color"]').value;
    const now = vi.spyOn(Date, "now");
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    // Start on the third stop, as the in-app run did.
    t.handles()[2].focus();
    const seen = [selected()];
    for (let k = 0; k < 5; k++) {
      clock += 600;
      // The handle on top: the selected one among those at 0.5 (z-index), else the last of them in document order.
      const atStack = t.handles().filter((h) => h.style.left === "50%");
      const top = atStack.find((h) => h.classList.contains("lf-ramp-handle-selected")) ?? atStack[atStack.length - 1];
      const down = new t.window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100, clientY: 20, button: 0, buttons: 1, pointerId: 1 });
      top.dispatchEvent(down as never);
      // What the browser does after a press it was not stopped from: the pressed element takes the focus.
      if (!down.defaultPrevented) top.focus();
      // The track has the pointer captured: the release and the click go to it.
      const track = t.q(".lf-ramp-track");
      track.dispatchEvent(new t.window.PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: 100, clientY: 20, button: 0, buttons: 0, pointerId: 1 }) as never);
      track.dispatchEvent(new t.window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 100, clientY: 20 }) as never);
      seen.push(selected());
    }
    now.mockRestore();
    expect(seen).toEqual(["#0000ff", "#ff0000", "#00ff00", "#0000ff", "#ff0000", "#00ff00"]);
    expect(t.labels).toEqual([]);
    // The keyboard acts on the selected stop: the focus is on its handle.
    expect(t.document.activeElement).toBe(t.handles().find((h) => h.classList.contains("lf-ramp-handle-selected")));
  });

  test("the kind label is a full-width line of its own under the select, not squeezed beside it", () => {
    const t = setup({ type: "solid", color: "#ff0000" });
    const kind = t.q(".lf-paint-kind");
    const head = t.q(".lf-paint-head");
    expect(kind.tagName).toBe("DIV");
    expect(head.contains(kind as never)).toBe(false);
    expect(head.querySelector('[data-key="fill.type"]')).not.toBeNull();
    // Straight after the select's row, before the slider.
    expect(head.nextElementSibling).toBe(kind);
    expect(kind.nextElementSibling?.classList.contains("lf-ramp-holder")).toBe(true);
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    const rule = /(^|\n)\.lf-paint-kind\s*{([^}]*)}/.exec(css)?.[2] ?? "";
    expect(rule).toMatch(/display:\s*block/);
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).not.toMatch(/flex:/);
  });
});
