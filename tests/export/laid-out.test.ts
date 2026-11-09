import { Window } from "happy-dom";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import type { Resolved } from "../../src/links/types";

const mocks = vi.hoisted(() => ({ snapdom: vi.fn() }));
vi.mock("@zumer/snapdom", () => ({ snapdom: mocks.snapdom }));
const { withLaidOut } = await import("../../src/export/laid-out");
const { collectAssets } = await import("../../src/export/assets");

/** A workspace like Obsidian's: two tabs, the figure's not shown (an inline `display: none`), a node body inside it. */
function workspace() {
  const window = new Window();
  const document = window.document;
  document.head.innerHTML = "<style>.collapsed { display: none; }</style>";
  document.body.innerHTML =
    '<div class="tabs"><div class="leaf shown">note</div>' +
    '<div class="leaf figure" style="display: none; color: red;"><div class="view"><div class="lf-node"><div class="lf-node-body">Legend</div></div></div></div></div>' +
    '<div class="collapsed"><div class="inner"></div></div>';
  const q = (sel: string) => document.querySelector(sel) as unknown as HTMLElement;
  return { window, leaf: q(".leaf.figure"), node: q(".lf-node"), body: q(".lf-node-body"), collapsed: q(".collapsed"), inner: q(".inner") };
}

const display = (el: HTMLElement) => el.ownerDocument.defaultView!.getComputedStyle(el).display;

describe("withLaidOut", () => {
  it("shows the hidden tab round the element off screen while the work runs, and puts its style back afterwards", async () => {
    const w = workspace();
    const before = w.leaf.getAttribute("style");
    const seen = await withLaidOut(w.body, async () => {
      const style = w.leaf.style;
      return { display: display(w.leaf), position: style.position, left: style.left, color: style.color };
    });
    expect(seen).toEqual({ display: "block", position: "fixed", left: "-100000px", color: "red" });
    expect(w.leaf.getAttribute("style")).toBe(before);
    expect(display(w.leaf)).toBe("none");
  });

  it("overrides a stylesheet's display: none, and takes the style attribute away again when there was none", async () => {
    const w = workspace();
    const inside = await withLaidOut(w.inner, async () => display(w.collapsed));
    expect(inside).toBe("block");
    expect(w.collapsed.hasAttribute("style")).toBe(false);
    expect(display(w.collapsed)).toBe("none");
  });

  it("leaves an element that is laid out as it is, and puts the style back when the work throws", async () => {
    const w = workspace();
    const shown = w.window.document.querySelector(".leaf.shown") as unknown as HTMLElement;
    await withLaidOut(shown, async () => expect(shown.hasAttribute("style")).toBe(false));
    await expect(withLaidOut(w.body, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(w.leaf.getAttribute("style")).toBe("display: none; color: red;");
  });

  it("puts back only what it set: a tab that is shown during the work stays shown, and its other styles stay", async () => {
    const w = workspace();
    await withLaidOut(w.body, async () => {
      // Obsidian shows the tab (the user switched to it) while the snapshot is taken.
      w.leaf.style.display = "";
      w.leaf.style.setProperty("opacity", "0.5");
    });
    expect(display(w.leaf)).not.toBe("none");
    const style = w.leaf.style;
    expect({ position: style.position, left: style.left, top: style.top, width: style.width, height: style.height, display: style.display }).toEqual({
      position: "",
      left: "",
      top: "",
      width: "",
      height: "",
      display: "",
    });
    expect({ color: style.color, opacity: style.opacity }).toEqual({ color: "red", opacity: "0.5" });
  });

  it("is safe to overlap: the tab stays laid out until the last of two exports is done, then is hidden as it was", async () => {
    const w = workspace();
    const before = w.leaf.getAttribute("style");
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstDone!: () => void;
    const firstFinished = new Promise<void>((resolve) => (firstDone = resolve));
    const first = withLaidOut(w.body, async () => {
      await firstHeld;
    }).then(firstDone);
    const second = withLaidOut(w.node, async () => {
      releaseFirst();
      await firstFinished;
      // The first export is done; this one is still taking its snapshot.
      return { display: display(w.leaf), left: w.leaf.style.left };
    });
    await first;
    expect(await second).toEqual({ display: "block", left: "-100000px" });
    expect(w.leaf.getAttribute("style")).toBe(before);
    expect(display(w.leaf)).toBe("none");
  });

  it("is safe to nest: an inner call does not hide what the outer one is still using", async () => {
    const w = workspace();
    const before = w.leaf.getAttribute("style");
    const after = await withLaidOut(w.body, async () => {
      await withLaidOut(w.node, async () => undefined);
      return display(w.leaf);
    });
    expect(after).toBe("block");
    expect(w.leaf.getAttribute("style")).toBe(before);
  });
});

describe("a content card in a tab that is not shown", () => {
  it("is snapshotted laid out (a hidden tab's card was blank), and the tab is hidden again afterwards", async () => {
    const w = workspace();
    const doc = createDocument("nature-double");
    const node = fileNodeDefaults(doc.pages[0], { file: "note", subpath: "", show: "content" }, []);
    doc.nodes.push(node);
    const resolved: Resolved = { kind: "content", file: { path: "note.md", extension: "md" }, markdown: "# Hi", deps: ["note.md"] };
    let displayAtSnapshot = "";
    mocks.snapdom.mockImplementation(async () => {
      displayAtSnapshot = display(w.leaf);
      return { toPng: async () => ({ src: "data:image/png;base64,Q0M=" }) };
    });
    const assets = await collectAssets(doc, doc.pages[0], {
      app: {} as never,
      resolved: () => resolved,
      elementFor: () => w.node,
      readBinary: async () => new ArrayBuffer(0),
      readText: async () => "",
      decoders: {} as never,
      dpi: 96,
      warnings: [],
    });
    expect(assets.get(node.id)).toEqual({ kind: "raster", dataUri: "data:image/png;base64,Q0M=" });
    expect(displayAtSnapshot).toBe("block");
    expect(display(w.leaf)).toBe("none");
  });
});
