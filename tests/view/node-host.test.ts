import { InvalidationIndex } from "../../src/links/invalidation";
import type { Plane } from "../../src/links/decoders/tiff-convert";
import type { Decoders, FileRef, Resolved } from "../../src/links/types";
import { createDocument, fileNodeDefaults, textNodeDefaults } from "../../src/model/defaults";
import { DocumentStore } from "../../src/model/store";
import type { Document, FileNode, Node, NodeId } from "../../src/model/types";
import type { Registries } from "../../src/registry";
import type { NodeRenderer, NodeType } from "../../src/registry/node-type";
import { NodeHost } from "../../src/view/node-host";
import { FakeAccess } from "../links/fake-access";
import { step, testRegistry } from "../adjust/fixtures";

vi.mock("obsidian", () => ({ Keymap: { isModEvent: () => false } }));

/** What a page's node host element amounts to for `NodeHost`: children in order, and the last of them. */
class FakeHost {
  children: { dataset: Record<string, string> }[] = [];
  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  replaceChildren(): void {
    this.children = [];
  }
}

interface Mounted {
  node: Node;
  updates: Node[];
  unmounted: boolean;
}

/** A node type that records what is done to its renderers, and what `ctx.resolved` said when it mounted. */
function recordingType() {
  const mounted: Mounted[] = [];
  const seenOnMount = new Map<NodeId, (Resolved | undefined)[]>();
  const type: NodeType = {
    type: "file",
    name: "x",
    icon: "x",
    mount(node, host, ctx) {
      const record: Mounted = { node, updates: [], unmounted: false };
      mounted.push(record);
      seenOnMount.set(node.id, [...(seenOnMount.get(node.id) ?? []), ctx.resolved(node.id)]);
      (host as unknown as FakeHost).children.push({ dataset: {} });
      const renderer: NodeRenderer = {
        update: (n) => void record.updates.push(n),
        unmount: () => void (record.unmounted = true),
      };
      return renderer;
    },
    bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    inspector: () => [],
    toSvg: () => "raster",
  };
  return { type, mounted, seenOnMount };
}

const PATHS = ["a.pdf", "b.pdf", "c.pdf"];

function setup() {
  const doc: Document = createDocument("a4-portrait");
  const [page] = doc.pages;
  for (const name of PATHS) doc.nodes.push(fileNodeDefaults(page, { file: name, subpath: "", show: "image" }, doc.nodes.map((n) => n.id)));
  const label = textNodeDefaults(page, {}, doc.nodes.map((n) => n.id));
  doc.nodes.push(label);

  const access = new FakeAccess({ files: Object.fromEntries([...PATHS, "d.pdf", "e.png", "f.tif"].map((p) => [p, "BINARY"])), mtimes: { "e.png": 1, "f.tif": 1 } });
  const reads: string[] = [];
  const readBinary = access.readBinary.bind(access);
  access.readBinary = (file: FileRef) => {
    reads.push(file.path);
    return readBinary(file);
  };
  const decodes: { release: () => void }[] = [];
  let hold = false;
  /** The decoders' samples cache, and the `decodeSamples` calls held back while `holdSamples` is on. */
  const planes = new Map<string, Plane>();
  const sampleDecodes: { release: () => void }[] = [];
  let holdSamples = false;
  const decoders: Decoders = {
    pdf: vi.fn(async (_bytes, pageIndex) => {
      if (hold) await new Promise<void>((release) => decodes.push({ release }));
      return { dataUrl: `data:page-${pageIndex}`, width: 10, height: 10, pageCount: 2 };
    }),
    tiff: vi.fn(async () => ({ dataUrl: "data:tiff", width: 2, height: 1, pageCount: 1 })),
    raster: vi.fn(),
    adjusts: () => false,
    samples: (key) => planes.get(key),
    decodeSamples: vi.fn(async (_bytes, _source, _pageIndex, key) => {
      if (holdSamples) await new Promise<void>((release) => sampleDecodes.push({ release }));
      const plane: Plane = { width: 2, height: 1, bitsPerSample: 8, samplesPerPixel: 4, data: new Uint8Array(8) };
      planes.set(key, plane);
      return plane;
    }),
  };

  const view = {
    app: {},
    file: { path: "fig.lnkfig.md" },
    store: new DocumentStore(doc),
    resolvedCache: new Map<NodeId, Resolved>(),
    index: new InvalidationIndex(),
    plugin: { access, decoders, registries: { adjustments: testRegistry() } },
    openLink: vi.fn(),
    samplesLanded: vi.fn(),
  };
  const hosts = new Map<string, FakeHost>([[page.id, new FakeHost()]]);
  const pageLayer = {
    nodesHost(id: string) {
      const host = hosts.get(id);
      if (!host) throw new Error("no such page");
      return host;
    },
  };
  const recording = recordingType();
  const nodeHost = new NodeHost(view as never, pageLayer as never, { nodeTypes: { get: () => recording.type } } as unknown as Registries);
  const [a, b, c] = doc.nodes as FileNode[];
  /** Replaces the view's document, as a reload does, with the links of some nodes changed. */
  const relink = (changes: Record<NodeId, string>): Document => {
    const next: Document = { ...view.store.doc, nodes: view.store.doc.nodes.map((n) => (n.type === "file" && changes[n.id] ? { ...n, file: changes[n.id] } : n)) };
    view.store = new DocumentStore(next);
    return next;
  };
  return {
    doc, view, nodeHost, access, reads, decoders, decodes, hold: (on: boolean) => (hold = on), recording, planes, sampleDecodes,
    holdSamples: (on: boolean) => (holdSamples = on), a, b, c, label, relink, host: hosts.get(page.id)!,
    ids: doc.nodes.map((n) => n.id),
    fileIds: [a.id, b.id, c.id],
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("renderAll then resolveStale", () => {
  test("resolves every file node the first time, and not the label", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    expect([...t.view.resolvedCache.keys()].sort()).toEqual(t.fileIds.sort());
    expect(t.reads.sort()).toEqual(PATHS);
    expect(t.view.index.nodesFor("a.pdf")).toEqual([t.a.id]);
  });

  test("draws everything again but resolves nothing for nodes whose link is unchanged, and they show the kept resolution at once", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    const before = new Map(t.view.resolvedCache);
    t.reads.length = 0;

    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();

    expect(t.reads).toEqual([]);
    expect(t.decoders.pdf).toHaveBeenCalledTimes(3);
    for (const id of t.fileIds) expect(t.view.resolvedCache.get(id)).toBe(before.get(id));
    // Mounted twice; the second time with the resolution already in hand.
    for (const id of t.fileIds) expect(t.recording.seenOnMount.get(id)?.map((r) => r?.kind)).toEqual([undefined, "image"]);
    expect(t.recording.mounted.filter((m) => !m.unmounted)).toHaveLength(4);
  });

  test("resolves again only the nodes whose link changed, and forgets those that are gone", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    t.reads.length = 0;

    const next = t.relink({ [t.b.id]: "d.pdf" });
    next.nodes = next.nodes.filter((n) => n.id !== t.c.id);
    t.nodeHost.renderAll(next);
    await t.nodeHost.resolveStale();

    expect(t.reads).toEqual(["d.pdf"]);
    expect(t.view.resolvedCache.has(t.c.id)).toBe(false);
    expect(t.view.index.nodesFor("c.pdf")).toEqual([]);
    expect(t.view.index.nodesFor("b.pdf")).toEqual([]);
    expect(t.view.index.nodesFor("d.pdf")).toEqual([t.b.id]);
  });

  test("a change to what a node shows of its file counts, not only to the file", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    t.reads.length = 0;
    const next: Document = { ...t.doc, nodes: t.doc.nodes.map((n) => (n.id === t.a.id ? ({ ...n, pageIndex: 1 } as Node) : n)) };
    t.view.store = new DocumentStore(next);
    t.nodeHost.renderAll(next);
    await t.nodeHost.resolveStale();
    expect(t.reads).toEqual(["a.pdf"]);
    // Its crop, its size and its place are not part of the resolution.
    t.reads.length = 0;
    const moved: Document = { ...next, nodes: next.nodes.map((n) => (n.id === t.b.id ? ({ ...n, x: 50, width: 7 } as Node) : n)) };
    t.view.store = new DocumentStore(moved);
    t.nodeHost.renderAll(moved);
    await t.nodeHost.resolveStale();
    expect(t.reads).toEqual([]);
  });

  test("a resolution still under way for a link that did not change is kept, and lands on the node drawn afterwards", async () => {
    const t = setup();
    t.hold(true);
    t.nodeHost.renderAll(t.doc);
    const first = t.nodeHost.resolveStale();
    await settle();
    expect(t.decodes).toHaveLength(3);

    t.nodeHost.renderAll(t.doc);
    const second = t.nodeHost.resolveStale();
    await settle();
    // Nothing started again.
    expect(t.decodes).toHaveLength(3);

    for (const d of t.decodes) d.release();
    await Promise.all([first, second]);
    expect([...t.view.resolvedCache.keys()].sort()).toEqual(t.fileIds.sort());
    const live = t.recording.mounted.filter((m) => !m.unmounted && m.node.id === t.a.id);
    expect(live).toHaveLength(1);
    expect(live[0].updates.length).toBeGreaterThan(0);
  });

  test("a resolution under way for a link that has since changed is dropped for the new one", async () => {
    const t = setup();
    t.hold(true);
    t.nodeHost.renderAll(t.doc);
    const first = t.nodeHost.resolveStale();
    await settle();

    const next = t.relink({ [t.a.id]: "e.png" });
    t.nodeHost.renderAll(next);
    const second = t.nodeHost.resolveStale();
    await settle();
    // `e.png` is a plain image: resolved without decoding.
    expect(t.view.resolvedCache.get(t.a.id)).toMatchObject({ kind: "image", file: { path: "e.png" } });

    for (const d of t.decodes) d.release();
    await Promise.all([first, second]);
    expect(t.view.resolvedCache.get(t.a.id)).toMatchObject({ kind: "image", file: { path: "e.png" } });
    expect(t.view.index.nodesFor("a.pdf")).toEqual([]);
  });
});

describe("adjustments", () => {
  const adjust = (t: ReturnType<typeof setup>, id: NodeId, adjustments: FileNode["adjustments"]): Document => {
    const next: Document = { ...t.view.store.doc, nodes: t.view.store.doc.nodes.map((n) => (n.id === id ? ({ ...n, adjustments } as Node) : n)) };
    t.view.store = new DocumentStore(next);
    return next;
  };

  test("a change to a node's adjustments resolves it again", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    t.reads.length = 0;
    t.nodeHost.applyChange(adjust(t, t.a.id, [step("test.invert")]), new Set([t.a.id]));
    await settle();
    expect(t.reads).toEqual(["a.pdf"]);
    // Switching one off is a change too.
    t.reads.length = 0;
    t.nodeHost.applyChange(adjust(t, t.a.id, [step("test.invert", false)]), new Set([t.a.id]));
    await settle();
    expect(t.reads).toEqual(["a.pdf"]);
  });

  test("an unregistered type is warned about once per type per view, and the node still resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    adjust(t, t.a.id, [step("future.one"), step("future.one"), step("test.invert"), step("future.off", false)]);
    adjust(t, t.b.id, [step("future.one"), step("future.two")]);
    t.nodeHost.renderAll(t.view.store.doc);
    await t.nodeHost.resolveStale();
    await t.nodeHost.resolve([t.a.id, t.b.id]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('"future.one"'),
      expect.stringContaining('"future.two"'),
    ]);
    expect(t.view.resolvedCache.get(t.a.id)).toMatchObject({ kind: "image" });
    // Another view warns afresh.
    const other = setup();
    adjust(other, other.a.id, [step("future.one")]);
    other.nodeHost.renderAll(other.view.store.doc);
    await other.nodeHost.resolveStale();
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("reset", () => {
  test("forgets everything, so the next round resolves every node again", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    t.nodeHost.reset();
    expect(t.view.resolvedCache.size).toBe(0);
    expect(t.view.index.nodesFor("a.pdf")).toEqual([]);
    t.reads.length = 0;
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    expect(t.reads.sort()).toEqual(PATHS);
  });
});

describe("applyChange", () => {
  test("after a link edit it resolves just the changed node, and keeps showing the old resolution until then", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    t.reads.length = 0;
    const next = t.relink({ [t.a.id]: "d.pdf" });

    t.nodeHost.applyChange(next, new Set([t.a.id]));
    expect(t.view.resolvedCache.get(t.a.id)).toMatchObject({ file: { path: "a.pdf" } });
    await settle();

    expect(t.reads).toEqual(["d.pdf"]);
    expect(t.view.resolvedCache.get(t.a.id)).toMatchObject({ file: { path: "d.pdf" } });
    // The panel was updated in place, not drawn again.
    const live = t.recording.mounted.filter((m) => m.node.id === t.a.id);
    expect(live).toHaveLength(1);
    expect(live[0].unmounted).toBe(false);
  });

  test("a change that is not to the link starts no resolution", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    t.reads.length = 0;
    const next: Document = { ...t.doc, nodes: t.doc.nodes.map((n) => (n.id === t.a.id ? ({ ...n, x: 9 } as Node) : n)) };
    t.view.store = new DocumentStore(next);
    t.nodeHost.applyChange(next, new Set([t.a.id]));
    await settle();
    expect(t.reads).toEqual([]);
  });
});

describe("nodes drawn from other nodes", () => {
  /** The setup's view and pages, drawn by a node host whose text type says it is drawn from panel a (as a connector is from its items). */
  function dependentSetup() {
    const t = setup();
    const dependent: NodeType = { ...t.recording.type, dependsOn: () => [t.a.id] };
    const registries = { nodeTypes: { get: (type: string) => (type === "text" ? dependent : t.recording.type) } } as unknown as Registries;
    const pageLayer = { nodesHost: () => t.host };
    const nodeHost = new NodeHost(t.view as never, pageLayer as never, registries);
    nodeHost.renderAll(t.doc);
    const updatesOf = (id: NodeId) => t.recording.mounted.filter((m) => m.node.id === id && !m.unmounted).flatMap((m) => m.updates);
    return { ...t, nodeHost, updatesOf };
  }

  test("a node is drawn again when only a node it depends on changed, from the document as it is now", () => {
    const t = dependentSetup();
    const next: Document = { ...t.doc, nodes: t.doc.nodes.map((n) => (n.id === t.a.id ? ({ ...n, x: 9 } as Node) : n)) };
    t.nodeHost.applyChange(next, new Set([t.a.id]));
    expect(t.updatesOf(t.label.id)).toEqual([next.nodes.find((n) => n.id === t.label.id)]);
    expect(t.updatesOf(t.b.id)).toEqual([]);
  });

  test("and when that node is removed; but not when another node changes, and only once when it changed itself", () => {
    const t = dependentSetup();
    const without: Document = { ...t.doc, nodes: t.doc.nodes.filter((n) => n.id !== t.a.id) };
    t.nodeHost.applyChange(without, new Set([t.a.id]));
    expect(t.updatesOf(t.label.id)).toHaveLength(1);
    t.nodeHost.applyChange(without, new Set([t.b.id]));
    expect(t.updatesOf(t.label.id)).toHaveLength(1);
    t.nodeHost.applyChange(t.doc, new Set([t.a.id, t.label.id]));
    expect(t.updatesOf(t.label.id)).toHaveLength(2);
  });
});

describe("resolve", () => {
  test("resolves the nodes asked for even when their link has not changed: the file may have", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    await t.nodeHost.resolveStale();
    t.reads.length = 0;
    await t.nodeHost.resolve([t.b.id]);
    expect(t.reads).toEqual(["b.pdf"]);
  });
});

describe("samplesNow", () => {
  test("a raster panel with no adjustments is drawn by <img> (no decode) until its samples are asked for", async () => {
    const t = setup();
    const next = t.relink({ [t.a.id]: "e.png" });
    t.nodeHost.renderAll(next);
    await t.nodeHost.resolveStale();
    expect(t.view.resolvedCache.get(t.a.id)).toMatchObject({ kind: "image", source: "raster", src: "app://e.png" });
    expect(t.reads).not.toContain("e.png");
    expect(t.decoders.raster).not.toHaveBeenCalled();
    expect(t.decoders.decodeSamples).not.toHaveBeenCalled();
  });

  test("returns null and starts one decode, then the plane once it lands; the chrome is drawn again once", async () => {
    const t = setup();
    t.holdSamples(true);
    const next = t.relink({ [t.a.id]: "e.png" });
    t.nodeHost.renderAll(next);
    await t.nodeHost.resolveStale();
    t.reads.length = 0;

    expect(t.nodeHost.samplesNow(t.a.id)).toBeNull();
    // Asked again while that decode is under way: no second one.
    expect(t.nodeHost.samplesNow(t.a.id)).toBeNull();
    await settle();
    expect(t.reads).toEqual(["e.png"]);
    expect(t.decoders.decodeSamples).toHaveBeenCalledTimes(1);
    expect(t.decoders.decodeSamples).toHaveBeenCalledWith(expect.any(ArrayBuffer), "raster", 0, expect.any(String));
    expect(t.view.samplesLanded).not.toHaveBeenCalled();

    for (const d of t.sampleDecodes) d.release();
    await settle();
    expect(t.view.samplesLanded).toHaveBeenCalledTimes(1);
    const plane = t.nodeHost.samplesNow(t.a.id);
    expect(plane).not.toBeNull();
    expect(plane).toBe([...t.planes.values()][0]);
    expect(t.view.samplesLanded).toHaveBeenCalledTimes(1);
    expect(t.reads).toEqual(["e.png"]);
  });

  test("the key follows the file's mtime: a changed file is decoded again", async () => {
    const t = setup();
    const next = t.relink({ [t.a.id]: "e.png" });
    t.nodeHost.renderAll(next);
    await t.nodeHost.resolveStale();
    t.nodeHost.samplesNow(t.a.id);
    await settle();
    expect(t.nodeHost.samplesNow(t.a.id)).not.toBeNull();
    t.access.setMtime("e.png", 2);
    expect(t.nodeHost.samplesNow(t.a.id)).toBeNull();
    await settle();
    expect(t.decoders.decodeSamples).toHaveBeenCalledTimes(2);
  });

  test("is null, and decodes nothing, for a PDF panel, a node that is not a panel, or one not resolved", async () => {
    const t = setup();
    t.nodeHost.renderAll(t.doc);
    expect(t.nodeHost.samplesNow(t.a.id)).toBeNull();
    await t.nodeHost.resolveStale();
    expect(t.nodeHost.samplesNow(t.a.id)).toBeNull();
    expect(t.nodeHost.samplesNow(t.label.id)).toBeNull();
    await settle();
    expect(t.decoders.decodeSamples).not.toHaveBeenCalled();
  });

  test("a TIFF panel is resolved with its samples key, which samplesNow then reads", async () => {
    const t = setup();
    const next = t.relink({ [t.a.id]: "f.tif" });
    t.nodeHost.renderAll(next);
    await t.nodeHost.resolveStale();
    const key = vi.mocked(t.decoders.tiff).mock.calls[0][3];
    expect(typeof key).toBe("string");
    const plane: Plane = { width: 1, height: 1, bitsPerSample: 16, samplesPerPixel: 1, data: new Uint16Array(1) };
    t.planes.set(key as string, plane);
    expect(t.nodeHost.samplesNow(t.a.id)).toBe(plane);
    expect(t.decoders.decodeSamples).not.toHaveBeenCalled();
  });
});
