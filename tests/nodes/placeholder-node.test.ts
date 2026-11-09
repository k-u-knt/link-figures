// @vitest-environment happy-dom
import { createDocument } from "../../src/model/defaults";
import type { Node } from "../../src/model/types";
import { nodeTypeOrPlaceholder, placeholderNodeType } from "../../src/nodes/placeholder-node";
import { groupNodeType } from "../../src/nodes/group-node";
import { createRegistries } from "../../src/registry";
import type { RenderContext } from "../../src/registry/node-type";

// Obsidian's `createDiv`, which the renderer uses to add its elements; happy-dom has the rest of the DOM.
beforeAll(() => {
  (HTMLElement.prototype as unknown as { createDiv: unknown }).createDiv = function (this: HTMLElement, info: { cls?: string | string[]; text?: string } = {}) {
    const el = this.ownerDocument.createElement("div");
    if (info.cls) el.classList.add(...(Array.isArray(info.cls) ? info.cls : [info.cls]));
    if (info.text !== undefined) el.textContent = info.text;
    this.appendChild(el);
    return el;
  };
});

const foreign = (over: Record<string, unknown> = {}): Node =>
  ({ id: "x-1", type: "x.chart", page: createDocument("a4-portrait").pages[0].id, x: 10, y: 20, width: 100, height: 50, z: 3, rotation: 15, opacity: 0.5, locked: false, series: [1], ...over }) as unknown as Node;

describe("the placeholder for a node no plugin draws", () => {
  test("is a dashed box over the node's box, labelled with its type", () => {
    const host = document.createElement("div");
    const renderer = placeholderNodeType("x.chart").mount(foreign(), host, {} as RenderContext);
    const el = host.lastElementChild as HTMLElement;
    expect(el.classList.contains("lf-node")).toBe(true);
    expect(el.classList.contains("lf-placeholder")).toBe(true);
    expect(el.textContent).toBe("Missing: x.chart");
    expect([el.style.left, el.style.top, el.style.width, el.style.height, el.style.zIndex]).toEqual(["10px", "20px", "100px", "50px", "3"]);
    expect(el.style.transform).toBe("rotate(15deg)");
    expect(el.style.opacity).toBe("0.5");
    renderer.update(foreign({ x: 40, rotation: 0, opacity: 1 }));
    expect([el.style.left, el.style.transform, el.style.opacity]).toEqual(["40px", "", ""]);
    renderer.unmount();
    expect(host.children).toHaveLength(0);
  });

  test("has no fields of its own, its box as bounds, and draws nothing in an export", () => {
    const type = placeholderNodeType("x.chart");
    expect(type.name).toBe("Missing: x.chart");
    expect(type.inspector(foreign(), { registries: createRegistries() })).toEqual([]);
    expect(type.bounds(foreign())).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(type.toSvg(foreign(), {} as never)).toBe("");
    // A placeholder is hit across its box, contains nothing, cannot be attached to and moves as a box does.
    expect(type.hitTest).toBeUndefined();
    expect(type.members).toBeUndefined();
    expect(type.attachable).toBeUndefined();
    expect(type.translate).toBeUndefined();
  });

  test("nodeTypeOrPlaceholder gives a registered type, else the placeholder", () => {
    const r = createRegistries();
    r.nodeTypes.register(groupNodeType);
    expect(nodeTypeOrPlaceholder(r, "group")).toBe(groupNodeType);
    expect(nodeTypeOrPlaceholder(r, "x.chart").name).toBe("Missing: x.chart");
  });
});
