import { cropCommands } from "../../src/commands/crop";
import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import { createDocument, fileNodeDefaults, groupNodeDefaults } from "../../src/model/defaults";
import { cropPlacement } from "../../src/model/geometry";
import { builtinSnapSources } from "../../src/model/snap";
import { DocumentStore } from "../../src/model/store";
import type { Document, FileNode, Node } from "../../src/model/types";
import { groupNodeType } from "../../src/nodes/group-node";
import { createRegistries } from "../../src/registry";
import type { CommandContext, UndoStep } from "../../src/registry/command";
import { PointerController } from "../../src/view/pointer";
import { SelectionState } from "../../src/view/selection";
import { Viewport } from "../../src/view/viewport";

// There is no DOM in this suite: a stage that only records its listeners, a page overlay that only keeps what is
// appended to it, and a view with just what a press, a drag, a double-click, the keys and `panel.crop` use.
class FakeStage {
  private readonly listeners = new Map<string, ((ev: any) => void)[]>();
  addEventListener(type: string, fn: (ev: any) => void, options?: { signal?: AbortSignal }): void {
    const entry = (ev: any) => fn(ev);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), entry]);
    options?.signal?.addEventListener("abort", () => this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== entry)));
  }
  fire(type: string, ev: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  setPointerCapture = () => {};
  hasPointerCapture = () => false;
  releasePointerCapture = () => {};
  focus = () => {};
}

class FakeBox {
  className = "";
  src = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeBox[] = [];
  parentElement: FakeBox | null = null;
  readonly ownerDocument = { createElement: (tag: string) => Object.assign(new FakeBox(), { tagName: tag.toUpperCase() }) };
  tagName = "DIV";
  appendChild(child: FakeBox): void {
    child.parentElement = this;
    this.children.push(child);
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  replaceChildren(...children: FakeBox[]): void {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
}

const NATURAL = { width: 200, height: 100 };

function setup(build: (doc: Document) => void) {
  const doc = createDocument("a4-portrait");
  build(doc);
  const overlay = new FakeBox();
  const registries = createRegistries();
  registries.nodeTypes.register(groupNodeType);
  for (const command of drawingCommands()) registries.commands.register(command);
  for (const command of cropCommands()) registries.commands.register(command);
  for (const source of builtinSnapSources) registries.snaps.register(source);
  const options = new Map<string, unknown>();
  const notices: string[] = [];
  const activated: string[] = [];
  const view = {
    store: undefined as unknown as DocumentStore,
    selection: new SelectionState(),
    viewport: new Viewport(),
    readOnly: false,
    plugin: { registries },
    viewOption: (key: string) => options.get(key),
    setViewOption: (key: string, value: unknown) => void options.set(key, value),
    isPanGesture: () => false,
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    nodeHost: { elementFor: (id: string) => ({ dispatchEvent: () => void activated.push(id) }) },
    pageLayer: { overlayHost: () => overlay },
    armedTool: null as object | null,
    disarmTool: () => void (view.armedTool = null),
    placeTool: () => {},
    imageSizeNow: (id: string) => (view.store.doc.nodes.some((n) => n.id === id && n.type === "file") ? NATURAL : null),
    imageSourceNow: () => "app://plot.png",
    notify: (message: string) => void notices.push(message),
    runCommandById: (id: string, args?: Record<string, unknown>, step?: UndoStep) => {
      if (args === undefined) return;
      const ctx: CommandContext = { app: {} as never, registries, view: view as never, store: view.store, selection: [...view.selection.ids], page: view.store.doc.pages[0] };
      void runCall(view.store, ctx, prepareCall(registries, { id, args }), step);
    },
  };
  const stage = new FakeStage();
  const controller = new PointerController(view as never);
  view.store = new DocumentStore(doc, () => controller.commitTime());
  const labels: string[] = [];
  view.store.subscribe((ev) => labels.push(ev.label));
  controller.attach(stage as never);
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, extra: object = {}) =>
    stage.fire(type, { pointerId: 1, isPrimary: true, button: 0, shiftKey: false, altKey: false, clientX, clientY, target: {}, preventDefault: () => {}, ...extra });
  /** A press at `from`, a move to `to` and the release there. */
  const drag = (from: [number, number], to: [number, number], extra: object = {}) => {
    pointer("pointerdown", from[0], from[1], extra);
    pointer("pointermove", to[0], to[1], extra);
    pointer("pointerup", to[0], to[1], extra);
  };
  const dblclick = (clientX: number, clientY: number) => stage.fire("dblclick", { clientX, clientY, target: stage });
  const key = (name: string) =>
    stage.fire("keydown", { key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, target: {}, preventDefault: () => {} });
  const node = (id = "p") => view.store.doc.nodes.find((n) => n.id === id) as FileNode;
  const box = (id = "p") => ({ x: node(id).x, y: node(id).y, width: node(id).width, height: node(id).height });
  /** Where the whole image is on the page. */
  const imageOnPage = (id = "p") => {
    const n = node(id);
    const { image } = cropPlacement(n, NATURAL, n.crop, n.fit);
    return { x: n.x + image.x, y: n.y + image.y, width: image.width, height: image.height };
  };
  const byClass = (cls: string) => {
    const out: FakeBox[] = [];
    const walk = (el: FakeBox) => {
      if (el.className.split(" ").includes(cls)) out.push(el);
      el.children.forEach(walk);
    };
    walk(overlay);
    return out;
  };
  const session = () => controller.cropSession;
  return { doc, view, controller, options, notices, activated, labels, overlay, pointer, drag, dblclick, key, node, box, imageOnPage, byClass, session };
}

/** A 200×100 image panel `p` at (10, 10), 200×100, showing the whole image; and any more nodes `more` builds. */
const panel = (partial: Partial<FileNode> = {}, more: (doc: Document) => void = () => {}) => (doc: Document) => {
  doc.nodes.push({
    ...fileNodeDefaults(doc.pages[0], { file: "plot.png", subpath: "", show: "image" }, []),
    id: "p", x: 10, y: 10, width: 200, height: 100, z: 0, ...partial,
  } as Node);
  more(doc);
};

describe("crop session", () => {
  test("starting draws the ghost (the whole image at 35 % behind the handles) and eight crop handles, and changes nothing", () => {
    const { controller, view, byClass, session, labels } = setup(panel({ crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, width: 100 }));
    const before = view.store.doc;
    expect(controller.startCrop("p")).toBe(true);
    expect(session().active).toBe(true);
    expect(view.selection.ids).toEqual(["p"]);
    expect(view.store.doc).toBe(before);
    expect(labels).toEqual([]);
    const [ghost] = byClass("lf-crop-ghost");
    expect(ghost.tagName).toBe("IMG");
    expect(ghost.src).toBe("app://plot.png");
    // The whole image: 200 wide, its left 50 px left of the box.
    expect(ghost.style).toMatchObject({ left: "-40px", top: "10px", width: "200px", height: "100px" });
    expect(byClass("lf-crop-handle")).toHaveLength(8);
    // Behind the handles: drawn first.
    const frame = byClass("lf-crop-frame")[0];
    expect(ghost.parentElement!.children.indexOf(ghost)).toBeLessThan(frame.parentElement!.children.indexOf(frame));
  });

  test("dragging the east handle 50 px left runs one panel.crop (keep image): the box is 50 px narrower and the image stays put", () => {
    const { controller, drag, box, node, labels, imageOnPage } = setup(panel());
    const image = imageOnPage();
    controller.startCrop("p");
    drag([210, 60], [160, 60]);
    expect(labels).toEqual(["panel.crop"]);
    expect(box()).toEqual({ x: 10, y: 10, width: 150, height: 100 });
    expect(node().crop).toEqual({ x: 0, y: 0, w: 0.75, h: 1 });
    expect(imageOnPage()).toEqual(image);
  });

  test("the west then the north handle in one session, then finish: one undo step restores both", () => {
    const { controller, view, drag, box, node, session } = setup(panel());
    controller.startCrop("p");
    drag([10, 60], [30, 60]);
    drag([120, 10], [120, 30]);
    session().finish();
    expect(session().active).toBe(false);
    expect(box()).toEqual({ x: 30, y: 30, width: 180, height: 80 });
    expect(node().crop!.x).toBeCloseTo(0.1, 10);
    expect(node().crop!.y).toBeCloseTo(0.2, 10);
    view.store.undo();
    expect(box()).toEqual({ x: 10, y: 10, width: 200, height: 100 });
    expect(node().crop).toBeNull();
    expect(view.store.canUndo()).toBe(false);
  });

  test("dragging inside the box 20 px right pans: the crop's x falls by 20 / the image's width, the box stays", () => {
    const { controller, drag, box, node } = setup(panel({ crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, width: 100, x: 60 }));
    const before = box();
    controller.startCrop("p");
    drag([100, 60], [120, 60]);
    expect(node().crop!.x).toBeCloseTo(0.25 - 20 / 200, 10);
    expect(node().crop!.w).toBeCloseTo(0.5, 10);
    expect(box()).toEqual(before);
  });

  test("panning stops at the image's left edge", () => {
    const { controller, drag, box, node } = setup(panel({ crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, width: 100, x: 60 }));
    const before = box();
    controller.startCrop("p");
    drag([100, 60], [400, 60]);
    expect(node().crop!.x).toBe(0);
    expect(box()).toEqual(before);
  });

  test("a handle stops at the image's edge", () => {
    const { controller, drag, box } = setup(panel({ crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, width: 100, x: 60 }));
    controller.startCrop("p");
    // The image reaches from 10 to 210: the west edge cannot go past 10.
    drag([60, 60], [-100, 60]);
    expect(box()).toEqual({ x: 10, y: 10, width: 150, height: 100 });
  });

  test("Shift on a corner keeps the box's aspect", () => {
    const { controller, drag, box } = setup(panel());
    controller.startCrop("p");
    drag([210, 110], [160, 100], { shiftKey: true });
    expect(box()).toEqual({ x: 10, y: 10, width: 150, height: 75 });
  });

  test("cancel after edits restores the entry state, with no extra undo step and nothing to redo", () => {
    const { controller, view, drag, session } = setup(panel());
    view.store.commit("before", (d) => void (d.nodes[0].x = 12));
    view.store.endMerge();
    const entry = view.store.doc;
    controller.startCrop("p");
    drag([212, 60], [160, 60]);
    drag([12, 60], [40, 60]);
    session().cancel();
    expect(session().active).toBe(false);
    expect(view.store.doc).toEqual(entry);
    expect(view.store.canRedo()).toBe(false);
    // The one step left is the edit made before the session.
    view.store.undo();
    expect(view.store.doc.nodes[0].x).toBe(10);
    expect(view.store.canUndo()).toBe(false);
  });

  test("Escape during a drag puts the crop back as the drag found it; Escape with no drag then cancels the session", () => {
    const { controller, view, pointer, key, session, node } = setup(panel());
    const entry = view.store.doc;
    controller.startCrop("p");
    // Two edits, each its own drag.
    pointer("pointerdown", 210, 60);
    pointer("pointermove", 160, 60);
    pointer("pointerup", 160, 60);
    pointer("pointerdown", 12, 60);
    pointer("pointermove", 40, 60);
    pointer("pointerup", 40, 60);
    const afterTwo = { crop: node().crop, box: { x: node().x, y: node().y, width: node().width, height: node().height } };
    // A third drag, then Escape in the middle of it.
    pointer("pointerdown", 100, 12);
    pointer("pointermove", 100, 40);
    expect(node().crop).not.toEqual(afterTwo.crop);
    key("Escape");
    expect(node().crop).toEqual(afterTwo.crop);
    expect({ x: node().x, y: node().y, width: node().width, height: node().height }).toEqual(afterTwo.box);
    expect(session().active).toBe(true);
    // The rest of that drag does nothing.
    pointer("pointermove", 100, 50);
    pointer("pointerup", 100, 50);
    expect(node().crop).toEqual(afterTwo.crop);
    // Escape again: the whole session goes, with no step left.
    key("Escape");
    expect(session().active).toBe(false);
    expect(view.store.doc).toEqual(entry);
    expect(view.store.canUndo()).toBe(false);
    expect(view.store.canRedo()).toBe(false);
  });

  test("Escape during a pan puts the image back, in the session's one step", () => {
    const { controller, view, pointer, key, session, node } = setup(panel());
    controller.startCrop("p");
    pointer("pointerdown", 210, 60);
    pointer("pointermove", 110, 60);
    pointer("pointerup", 110, 60);
    const crop = node().crop;
    pointer("pointerdown", 60, 60);
    pointer("pointermove", 40, 60);
    expect(node().crop).not.toEqual(crop);
    key("Escape");
    expect(node().crop).toEqual(crop);
    expect(session().active).toBe(true);
    session().finish();
    view.store.undo();
    expect(view.store.canUndo()).toBe(false);
  });

  test("cancel with no edit leaves the history as it was", () => {
    const { controller, view, session } = setup(panel());
    view.store.commit("before", (d) => void (d.nodes[0].x = 12));
    const entry = view.store.doc;
    controller.startCrop("p");
    session().cancel();
    expect(view.store.doc).toBe(entry);
    expect(view.store.canUndo()).toBe(true);
    view.store.undo();
    expect(view.store.canUndo()).toBe(false);
  });

  describe("a cover panel whose box aspect differs from its crop (Review Focus 5)", () => {
    // The 200×100 image covers a 100×100 box: its middle half shows, from 10 to 110.
    const cover = panel({ fit: "cover", width: 100, height: 100 });

    test("finish with no drag leaves the document unchanged and adds nothing to undo", () => {
      const { controller, view, session, labels, key } = setup(cover);
      const before = view.store.doc;
      controller.startCrop("p");
      session().finish();
      expect(view.store.doc).toBe(before);
      expect(view.store.canUndo()).toBe(false);
      // Through Enter as well.
      controller.startCrop("p");
      key("Enter");
      expect(session().active).toBe(false);
      expect(view.store.doc).toBe(before);
      expect(view.store.canUndo()).toBe(false);
      expect(labels).toEqual([]);
    });

    test("the first real edit folds in the normalisation: one step, and the part outside the edited edge does not jump", () => {
      const { controller, view, drag, box, node, imageOnPage } = setup(cover);
      const image = imageOnPage();
      controller.startCrop("p");
      drag([110, 60], [90, 60]);
      controller.cropSession.finish();
      // The visible part was the image's x 0.25–0.75; its left edge stays at 10, the right comes in by 20 px.
      expect(box()).toEqual({ x: 10, y: 10, width: 80, height: 100 });
      expect(node().crop!.x).toBeCloseTo(0.25, 10);
      expect(node().crop!.w).toBeCloseTo(0.4, 10);
      expect(imageOnPage()).toEqual(image);
      view.store.undo();
      expect(node()).toMatchObject({ x: 10, y: 10, width: 100, height: 100, crop: null });
      expect(view.store.canUndo()).toBe(false);
    });

    test("a pan as the first edit is one step too, the box unchanged", () => {
      const { controller, view, drag, box, node } = setup(cover);
      controller.startCrop("p");
      drag([60, 60], [80, 60]);
      controller.cropSession.finish();
      expect(box()).toEqual({ x: 10, y: 10, width: 100, height: 100 });
      expect(node().crop!.x).toBeCloseTo(0.15, 10);
      expect(node().crop!.w).toBeCloseTo(0.5, 10);
      view.store.undo();
      expect(node().crop).toBeNull();
      expect(view.store.canUndo()).toBe(false);
    });
  });

  describe("a contain panel letterboxed along the dragged axis", () => {
    // The 200×100 image is contained in a 200×200 box at (10, 10): it shows from y 60 to 160, the box reaching 10 to 210.
    const letterboxed = panel({ fit: "contain", width: 200, height: 200 });

    test("the south handle, on the box, takes the visible edge to the pointer, in one undo step", () => {
      const { controller, view, pointer, box } = setup(letterboxed);
      controller.startCrop("p");
      pointer("pointerdown", 110, 210);
      pointer("pointermove", 110, 150);
      expect(box()).toEqual({ x: 10, y: 60, width: 200, height: 90 });
      pointer("pointermove", 110, 140);
      expect(box().y + box().height).toBe(140);
      pointer("pointerup", 110, 140);
      controller.cropSession.finish();
      view.store.undo();
      expect(box()).toEqual({ x: 10, y: 10, width: 200, height: 200 });
      expect(view.store.canUndo()).toBe(false);
    });

    test("the first edit keeps the visible image where it was on the page", () => {
      const { controller, drag, imageOnPage, box } = setup(letterboxed);
      const image = imageOnPage();
      controller.startCrop("p");
      drag([210, 110], [190, 110]);
      expect(imageOnPage()).toEqual(image);
      expect(box()).toEqual({ x: 10, y: 60, width: 180, height: 100 });
    });
  });

  test("a crop handle snaps to another item's edge, with a guide; the panel's own edges are not lines", () => {
    const { controller, drag, box, byClass, pointer } = setup(
      panel({ crop: { x: 0, y: 0, w: 0.5, h: 1 }, width: 100, height: 100 }, (doc) => {
        doc.nodes.push({ ...fileNodeDefaults(doc.pages[0], { file: "b.png", subpath: "", show: "image" }, ["p"]), id: "b", x: 200, y: 300, width: 50, height: 50, z: 1 } as Node);
      }),
    );
    controller.startCrop("p");
    pointer("pointerdown", 110, 60);
    pointer("pointermove", 196, 60);
    expect(box().width).toBe(190);
    expect(byClass("lf-snap-guide")).toHaveLength(1);
    pointer("pointerup", 196, 60);
    expect(byClass("lf-snap-guide")).toHaveLength(0);
    // With Alt held it does not snap.
    drag([200, 60], [196, 60], { altKey: true });
    expect(box().width).toBe(186);
  });

  test("a double-click on an image panel starts a session; another double-click finishes it", () => {
    const { dblclick, session, activated } = setup(panel());
    dblclick(60, 60);
    expect(session().active).toBe(true);
    expect(session().id).toBe("p");
    dblclick(60, 60);
    expect(session().active).toBe(false);
    expect(activated).toEqual([]);
  });

  test("inside a group, the first double-click enters it and the next starts a session on the panel", () => {
    const { dblclick, session, view } = setup(
      panel({ parent: "g" }, (doc) => {
        doc.nodes.push({ ...fileNodeDefaults(doc.pages[0], { file: "b.png", subpath: "", show: "image" }, ["p"]), id: "q", x: 300, y: 10, width: 50, height: 50, z: 1, parent: "g" } as Node);
        doc.nodes.push({ ...groupNodeDefaults(doc.pages[0], { id: "g" }, ["p", "q"]), x: 10, y: 10, width: 340, height: 100 } as Node);
      }),
    );
    dblclick(60, 60);
    expect(session().active).toBe(false);
    expect(view.selection.ids).toEqual(["p"]);
    dblclick(60, 60);
    expect(session().active).toBe(true);
    expect(session().id).toBe("p");
  });

  test("a double-click on a rotated panel shows the Notice and starts no session", () => {
    const { dblclick, session, notices, activated } = setup(panel({ rotation: 30 }));
    dblclick(60, 60);
    expect(notices).toEqual(["Set rotation to 0 to crop on the page"]);
    expect(session().active).toBe(false);
    expect(activated).toEqual([]);
  });

  test("Escape (cancel) and Enter (finish) go through the pointer's key handler", () => {
    const { controller, view, drag, key, session, box } = setup(panel());
    controller.startCrop("p");
    drag([210, 60], [160, 60]);
    key("Escape");
    expect(session().active).toBe(false);
    expect(box()).toEqual({ x: 10, y: 10, width: 200, height: 100 });
    expect(view.store.canUndo()).toBe(false);
    // The selection is kept: Escape ended the session, not the selection.
    expect(view.selection.ids).toEqual(["p"]);

    controller.startCrop("p");
    drag([210, 60], [160, 60]);
    key("Enter");
    expect(session().active).toBe(false);
    expect(box().width).toBe(150);
    expect(view.store.canUndo()).toBe(true);
  });

  test("a press outside the box finishes the session (and is a press as any other)", () => {
    const { controller, view, pointer, session } = setup(panel());
    controller.startCrop("p");
    pointer("pointerdown", 400, 400);
    pointer("pointerup", 400, 400);
    expect(session().active).toBe(false);
    expect(view.selection.ids).toEqual([]);
  });

  test("selecting something else, arming a tool or deleting the panel ends the session; the ghost and handles go", () => {
    const more = (doc: Document) => {
      doc.nodes.push({ ...fileNodeDefaults(doc.pages[0], { file: "b.png", subpath: "", show: "image" }, ["p"]), id: "b", x: 300, y: 300, width: 50, height: 50, z: 1 } as Node);
    };
    const { controller, view, session, byClass, pointer } = setup(panel({}, more));
    controller.startCrop("p");
    view.selection.set(["b"]);
    expect(session().active).toBe(false);
    expect(byClass("lf-crop-ghost")).toHaveLength(0);
    expect(byClass("lf-crop-handle")).toHaveLength(0);

    controller.startCrop("p");
    view.armedTool = { id: "tool", place: () => {} };
    pointer("pointerdown", 60, 60);
    expect(session().active).toBe(false);
    view.armedTool = null;

    controller.startCrop("p");
    controller.finishCrop();
    expect(session().active).toBe(false);

    controller.startCrop("p");
    view.store.commit("delete", (d) => void (d.nodes = d.nodes.filter((n) => n.id !== "p")));
    expect(session().active).toBe(false);
    expect(byClass("lf-crop-ghost")).toHaveLength(0);
  });

  test("a locked panel, or one that shows no image, starts no session", () => {
    const locked = setup(panel({ locked: true }));
    expect(locked.controller.startCrop("p")).toBe(false);
    const content = setup(panel({ show: "content" }));
    expect(content.controller.startCrop("p")).toBe(false);
  });
});

describe("crop.edit", () => {
  function context(partial: Partial<FileNode>, selection = ["p"]) {
    const doc = createDocument("a4-portrait");
    panel(partial)(doc);
    const registries = createRegistries();
    for (const command of cropCommands()) registries.commands.register(command);
    const started: string[] = [];
    const view = { startCrop: (id: string) => void started.push(id), imageSizeNow: () => NATURAL };
    const ctx: CommandContext = { app: {} as never, registries, view: view as never, store: new DocumentStore(doc), selection, page: doc.pages[0] };
    return { command: registries.commands.get("crop.edit")!, ctx, started };
  }

  test("is a needsView toolbar button in edit, with the crop icon, labelled Crop", () => {
    const { command } = context({});
    expect([command.group, command.icon, command.name, !!command.needsView, !!command.hidden]).toEqual(["edit", "crop", "Crop", true, false]);
  });

  test("applies to exactly one unlocked image panel, and starts the view's crop session on it", () => {
    const one = context({});
    expect(one.command.applies(one.ctx)).toBe(true);
    void one.command.run(one.ctx, undefined);
    expect(one.started).toEqual(["p"]);
    expect(context({}, []).command.applies(context({}, []).ctx)).toBe(false);
    const locked = context({ locked: true });
    expect(locked.command.applies(locked.ctx)).toBe(false);
    const content = context({ show: "content" });
    expect(content.command.applies(content.ctx)).toBe(false);
  });
});
