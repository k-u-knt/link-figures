import { MM_TO_PX } from "../../src/constants";
import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import { DocumentStore } from "../../src/model/store";
import type { FileNode } from "../../src/model/types";
import { Viewport } from "../../src/view/viewport";
import { FakeAccess, type FakeVault } from "./fake-access";

// `obsidian` ships only typings; the intake needs just these two.
const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("obsidian", () => ({
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "") || "/",
}));
const { Intake } = await import("../../src/links/intake");
type IntakeInstance = InstanceType<typeof Intake>;
type ViewArg = ConstructorParameters<typeof Intake>[0];

const FIGURE = "Figures/fig.lnkfig.md";
const A4_WIDTH_PX = mmToPx(210);
/** What a file node's width is by default: 40% of the page's. */
const NODE_WIDTH_PX = 0.4 * A4_WIDTH_PX;
/** Where the second page starts, in world pixels. */
const PAGE2_Y_PX = mmToPx(297 + 20);

interface Size {
  width: number;
  height: number;
}

type Setup = ReturnType<typeof setup>;

/** A figure with two stacked A4 pages (and optionally nodes), a vault with the given files, and an intake attached to a fake stage. */
function setup(opts: { files?: Record<string, string>; folders?: string[] } = {}) {
  const page1 = createPage("a4-portrait", [], "Page 1");
  const page2 = createPage("a4-portrait", [page1.id], "Page 2");
  const doc = { ...createDocument("a4-portrait"), pages: [page1, page2] };
  const store = new DocumentStore(doc);
  const commits: string[] = [];
  store.subscribe((ev) => ev.kind === "commit" && commits.push(ev.label));

  const files: Record<string, string> = { "Notes/analysis.md": "text", "Notes/plot.png": "BINARY", "Notes/chart.svg": "BINARY", ...opts.files };
  const folders = new Set(opts.folders ?? []);
  const written = new Map<string, ArrayBuffer>();
  const images: Record<string, Size> = {
    "app://Notes/plot.png": { width: 400, height: 200 },
    "app://Notes/chart.svg": { width: 0, height: 0 },
  };
  const settings = { attachmentFolder: "" };
  const pdf = vi.fn(async () => ({ dataUrl: "data:pdf-page", width: 300, height: 600, pageCount: 1 }));
  const exists = (path: string) => path in files || folders.has(path);

  const view = {
    file: { path: FIGURE },
    readOnly: false,
    app: {
      dragManager: undefined as { draggable?: unknown } | undefined,
      vault: {
        getAbstractFileByPath: (path: string) => (exists(path) ? { path } : null),
        createFolder: vi.fn(async (path: string) => {
          if (exists(path)) throw new Error("Folder already exists.");
          folders.add(path);
        }),
        createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
          if (exists(path)) throw new Error("File already exists.");
          files[path] = "BINARY";
          written.set(path, data);
        }),
      },
      fileManager: {
        getAvailablePathForAttachment: vi.fn(async (name: string) => {
          let candidate = `attachments/${name}`;
          for (let n = 1; exists(candidate); n++) candidate = `attachments/${name.replace(/(\.[^.]*)?$/, ` ${n}$1`)}`;
          return candidate;
        }),
      },
    },
    plugin: {
      settings,
      access: new FakeAccess({ files } as FakeVault),
      decoders: { pdf, tiff: vi.fn() },
    },
    store,
    viewport: new Viewport(),
    stageEl: { clientWidth: 800, clientHeight: 600, focus: vi.fn() },
    stagePoint: (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX, y: ev.clientY }),
    currentPage: () => store.doc.pages[0],
    setSelection: vi.fn(),
    nodeHost: { resolve: vi.fn(async () => {}) },
    handlers: {} as Record<string, (ev: any) => void>,
    registerDomEvent(_el: unknown, type: string, fn: (ev: any) => void) {
      this.handlers[type] = fn;
    },
  };

  // Images load (or fail) by what `images` says.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(value: string) {
      queueMicrotask(() => {
        const size = images[value];
        if (!size) return this.onerror?.();
        this.naturalWidth = size.width;
        this.naturalHeight = size.height;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);

  const intake = new Intake(view as unknown as ViewArg);
  intake.attach({} as HTMLElement);
  return { intake, store, written, files, images, settings, folders, commits, view, pdf, handlers: view.handlers };
}

/** Puts a node of the given z on page `index` (0 or 1), as if it had been there already. */
function seed(s: Setup, index: number, z: number): void {
  const page = s.store.doc.pages[index];
  s.store.commit("seed", (draft) => {
    draft.nodes.push(fileNodeDefaults(page, { file: "old.png", subpath: "", show: "image", z }, draft.nodes.map((n) => n.id)));
  });
  s.commits.length = 0;
}

const osFile = (name: string, type = "image/png", bytes = [1, 2, 3]) => ({
  name,
  type,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

const dropEvent = (over: { x?: number; y?: number; files?: unknown[]; text?: string } = {}) => ({
  preventDefault: vi.fn(),
  clientX: over.x ?? 100,
  clientY: over.y ?? 150,
  dataTransfer: { files: over.files ?? [], getData: () => over.text ?? "", dropEffect: "none" },
});

const pasteEvent = (items: { kind: "file" | "string"; type: string; file?: unknown }[], text = "", target: unknown = { tagName: "DIV" }) => ({
  preventDefault: vi.fn(),
  target,
  clipboardData: {
    items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file ?? null })),
    getData: () => text,
  },
});

const fileNodes = (s: Setup) => s.store.doc.nodes.filter((n): n is FileNode => n.type === "file");

beforeEach(() => {
  notices.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a file dragged from Obsidian", () => {
  test("an image lands at the drop point, 40% of the page wide with the picture's aspect, selected and drawn", async () => {
    const s = setup();
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/plot.png" } } };
    const ev = dropEvent({ x: 100, y: 150 });
    s.handlers.drop(ev);
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));

    const [node] = fileNodes(s);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect([node.file, node.subpath, node.show, node.page]).toEqual(["Notes/plot.png", "", "image", s.store.doc.pages[0].id]);
    expect([node.x, node.y]).toEqual([100, 150]);
    expect(node.width).toBeCloseTo(NODE_WIDTH_PX, 6);
    expect(node.height).toBeCloseTo(NODE_WIDTH_PX / 2, 1);
    expect(s.view.setSelection).toHaveBeenCalledWith([node.id]);
    expect(s.view.nodeHost.resolve).toHaveBeenCalledWith([node.id]);
    expect(s.view.stageEl.focus).toHaveBeenCalled();
  });

  test("the node is placed on the page under the pointer, relative to that page", async () => {
    const s = setup();
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/plot.png" } } };
    s.handlers.drop(dropEvent({ x: 50, y: PAGE2_Y_PX + 200 }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    const [node] = fileNodes(s);
    expect(node.page).toBe(s.store.doc.pages[1].id);
    expect([node.x, node.y]).toEqual([50, 200]);
  });

  test("over no page it goes to the current page, relative to that page's origin", async () => {
    const s = setup();
    s.view.currentPage = () => s.store.doc.pages[1];
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/plot.png" } } };
    // Beside page 1, which is 794 px wide.
    s.handlers.drop(dropEvent({ x: 900, y: 100 }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    const [node] = fileNodes(s);
    expect(node.page).toBe(s.store.doc.pages[1].id);
    expect(node.x).toBe(900);
    expect(node.y).toBeCloseTo(100 - PAGE2_Y_PX, 1);
  });

  test("the position accounts for pan and zoom", async () => {
    const s = setup();
    s.view.viewport.tx = 40;
    s.view.viewport.ty = 20;
    s.view.viewport.zoom = 2;
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/plot.png" } } };
    s.handlers.drop(dropEvent({ x: 240, y: 220 }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect([fileNodes(s)[0].x, fileNodes(s)[0].y]).toEqual([100, 100]);
  });

  test("a note becomes a content card at the default size, linked without its extension", async () => {
    const s = setup();
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/analysis.md" } } };
    s.handlers.drop(dropEvent());
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    const [node] = fileNodes(s);
    expect([node.file, node.subpath, node.show]).toEqual(["Notes/analysis", "", "content"]);
    expect(node.width).toBeCloseTo(NODE_WIDTH_PX, 6);
    expect(node.height).toBeCloseTo(0.25 * mmToPx(297), 6);
  });

  test("several files go in one commit, staggered 10 mm down, each above the last, above what was on the page", async () => {
    const s = setup();
    seed(s, 0, 5);
    seed(s, 1, 9);
    s.view.app.dragManager = { draggable: { type: "files", files: [{ path: "Notes/plot.png" }, { path: "Notes/analysis.md" }, { path: "Notes/chart.svg" }] } };
    s.handlers.drop(dropEvent({ x: 60, y: 80 }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(5));

    const added = fileNodes(s).slice(2);
    expect(added.map((n) => n.file)).toEqual(["Notes/plot.png", "Notes/analysis", "Notes/chart.svg"]);
    expect(added.map((n) => n.page)).toEqual(Array(3).fill(s.store.doc.pages[0].id));
    expect(added.map((n) => n.x)).toEqual([60, 60, 60]);
    added.forEach((n, i) => expect(n.y).toBeCloseTo(80 + i * mmToPx(10), 2));
    // Page 1 held z 5; the z 9 on page 2 does not count.
    expect(added.map((n) => n.z)).toEqual([6, 7, 8]);
    expect(s.commits).toEqual(["insert"]);
    expect(new Set(fileNodes(s).map((n) => n.id)).size).toBe(5);
  });

  test("one undo takes every new node out; the vault is untouched", async () => {
    const s = setup();
    s.view.app.dragManager = { draggable: { type: "files", files: [{ path: "Notes/plot.png" }, { path: "Notes/analysis.md" }] } };
    s.handlers.drop(dropEvent());
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(2));
    s.store.undo();
    expect(fileNodes(s)).toHaveLength(0);
  });

  test("an image whose SVG has no size of its own keeps the default box", async () => {
    const s = setup();
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/chart.svg" } } };
    s.handlers.drop(dropEvent());
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(fileNodes(s)[0].height).toBeCloseTo(0.25 * mmToPx(297), 6);
  });

  test("a PDF is decoded and measured from its rendered page", async () => {
    const s = setup({ files: { "Notes/paper.pdf": "BINARY" } });
    s.images["data:pdf-page"] = { width: 300, height: 600 };
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/paper.pdf" } } };
    s.handlers.drop(dropEvent());
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(fileNodes(s)[0].height).toBeCloseTo(NODE_WIDTH_PX * 2, 1);
  });

  test("a PDF that cannot be decoded is reported and left out; the rest of the drop goes in", async () => {
    const s = setup({ files: { "Notes/bad.pdf": "BINARY" } });
    s.pdf.mockRejectedValue(new Error("corrupt"));
    s.view.app.dragManager = { draggable: { type: "files", files: [{ path: "Notes/bad.pdf" }, { path: "Notes/plot.png" }] } };
    s.handlers.drop(dropEvent());
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(fileNodes(s)[0].file).toBe("Notes/plot.png");
    expect(notices).toEqual(["Link Figures: Notes/bad.pdf could not be decoded, so it was not added."]);
  });

  test("an image that will not load is reported and left out", async () => {
    const s = setup({ files: { "Notes/broken.png": "BINARY" } });
    s.view.app.dragManager = { draggable: { type: "files", files: [{ path: "Notes/broken.png" }, { path: "Notes/plot.png" }] } };
    s.handlers.drop(dropEvent());
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(notices).toEqual(["Link Figures: Notes/broken.png could not be decoded, so it was not added."]);
  });

  test("other kinds of file are skipped, in one Notice that names them", async () => {
    const s = setup({ files: { "Notes/data.csv": "x", "Notes/board.canvas": "x" } });
    s.view.app.dragManager = { draggable: { type: "files", files: [{ path: "Notes/data.csv" }, { path: "Notes/plot.png" }, { path: "Notes/board.canvas" }] } };
    s.handlers.drop(dropEvent());
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(notices).toEqual(["Link Figures: skipped data.csv, board.canvas: not an image, PDF or TIFF file."]);
  });

  test("a folder, or a draggable of a shape we do not know, does nothing but is not left to the browser", () => {
    const s = setup();
    for (const draggable of [{ type: "folder", file: { path: "Notes" } }, { type: "mystery" }, "text", null]) {
      s.view.app.dragManager = { draggable };
      const ev = dropEvent();
      s.handlers.drop(ev);
      expect(ev.preventDefault).toHaveBeenCalled();
    }
    s.view.app.dragManager = undefined;
    s.handlers.drop(dropEvent());
    expect(fileNodes(s)).toHaveLength(0);
    expect(notices).toEqual([]);
  });

  test("a link drag is linked as written, a note by what it resolves to", async () => {
    const s = setup();
    s.view.app.dragManager = { draggable: { type: "link", linktext: "analysis#^fig2b", sourcePath: "Notes/x.md" } };
    s.handlers.drop(dropEvent({ y: 100 }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    s.view.app.dragManager = { draggable: { type: "link", linktext: "plot.png", sourcePath: "Notes/x.md" } };
    s.handlers.drop(dropEvent({ y: 700 }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(2));
    const [note, image] = fileNodes(s);
    expect([note.file, note.subpath, note.show]).toEqual(["analysis", "#^fig2b", "content"]);
    expect([image.file, image.subpath, image.show]).toEqual(["plot.png", "", "image"]);
    expect(image.height).toBeCloseTo(NODE_WIDTH_PX / 2, 1);
  });
});

describe("text dropped or pasted", () => {
  test("a dropped wikilink makes a node, even to a link that goes nowhere (it shows as missing, at the default size)", async () => {
    const s = setup();
    s.handlers.drop(dropEvent({ text: "![[analysis#Figure 2]] and [[ghost.png]] and [[Nowhere]]" }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(3));
    expect(fileNodes(s).map((n) => [n.file, n.subpath, n.show])).toEqual([
      ["analysis", "#Figure 2", "content"],
      ["ghost.png", "", "image"],
      ["Nowhere", "", "content"],
    ]);
    for (const node of fileNodes(s)) expect(node.height).toBeCloseTo(0.25 * mmToPx(297), 6);
  });

  test("a link to a file of another kind is skipped and named", async () => {
    const s = setup({ files: { "Notes/data.csv": "x" } });
    s.handlers.drop(dropEvent({ text: "[[data.csv]] [[plot.png]]" }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(notices).toEqual(["Link Figures: skipped data.csv: not an image, PDF or TIFF file."]);
  });

  test("text with nothing to link is ignored", () => {
    const s = setup();
    const ev = dropEvent({ text: "some words" });
    s.handlers.drop(ev);
    expect(fileNodes(s)).toHaveLength(0);
    expect(notices).toEqual([]);
  });

  test("pasting links makes one node each, at the middle of the stage on the current page", async () => {
    const s = setup();
    const ev = pasteEvent([{ kind: "string", type: "text/plain" }], "see [[analysis#^fig2b]] and ![[plot.png]]");
    s.handlers.paste(ev);
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(2));
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(fileNodes(s).map((n) => n.show)).toEqual(["content", "image"]);
    expect(fileNodes(s)[0].x).toBe(400);
    expect(fileNodes(s)[0].y).toBe(300);
    expect(s.commits).toEqual(["insert"]);
  });

  test("a paste lands on the page even when the middle of the stage is off it", async () => {
    const s = setup();
    s.view.currentPage = () => s.store.doc.pages[0];
    s.view.viewport.tx = -5000;
    s.view.viewport.ty = 5000;
    s.handlers.paste(pasteEvent([{ kind: "string", type: "text/plain" }], "[[plot.png]]"));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    const [node] = fileNodes(s);
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.x + node.width).toBeLessThanOrEqual(A4_WIDTH_PX + 0.01);
    expect(node.y).toBeGreaterThanOrEqual(0);
    expect(node.y + node.height).toBeLessThanOrEqual(mmToPx(297) + 0.01);
  });

  test("a paste with nothing for us is left to the browser", () => {
    const s = setup();
    const ev = pasteEvent([{ kind: "string", type: "text/plain" }], "plain words");
    s.handlers.paste(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(fileNodes(s)).toHaveLength(0);
  });

  test("a paste into a text field keeps its text", () => {
    const s = setup();
    const ev = pasteEvent([{ kind: "string", type: "text/plain" }], "[[plot.png]]", { tagName: "INPUT" });
    s.handlers.paste(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(fileNodes(s)).toHaveLength(0);
  });
});

describe("files from the OS", () => {
  test("with Obsidian's attachment setting, the path comes from Obsidian and the node links the saved file", async () => {
    const s = setup();
    s.images["app://attachments/shot.png"] = { width: 100, height: 300 };
    s.handlers.drop(dropEvent({ files: [osFile("shot.png", "image/png", [9, 8, 7])] }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));

    expect(s.view.app.fileManager.getAvailablePathForAttachment).toHaveBeenCalledWith("shot.png", FIGURE);
    expect([...s.written.keys()]).toEqual(["attachments/shot.png"]);
    expect([...new Uint8Array(s.written.get("attachments/shot.png")!)]).toEqual([9, 8, 7]);
    const [node] = fileNodes(s);
    expect([node.file, node.subpath, node.show]).toEqual(["attachments/shot.png", "", "image"]);
    expect(node.height).toBeCloseTo(NODE_WIDTH_PX * 3, 1);
  });

  test("with the override folder: created if missing, and a name already there is never overwritten", async () => {
    const s = setup({ files: { "assets/plot.png": "BINARY", "assets/plot 1.png": "BINARY" } });
    s.settings.attachmentFolder = "assets";
    s.images["app://assets/plot 2.png"] = { width: 10, height: 10 };
    s.handlers.drop(dropEvent({ files: [osFile("plot.png")] }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect([...s.written.keys()]).toEqual(["assets/plot 2.png"]);
    expect(fileNodes(s)[0].file).toBe("assets/plot 2.png");
    expect(s.files["assets/plot.png"]).toBe("BINARY");
  });

  test("the same file dropped again and again gets a fresh name each time, and the folder is created once", async () => {
    const s = setup();
    s.settings.attachmentFolder = " assets/ ";
    for (const name of ["assets/cell.png", "assets/cell 1.png", "assets/cell 2.png"]) s.images[`app://${name}`] = { width: 10, height: 10 };
    for (let i = 1; i <= 3; i++) {
      s.handlers.drop(dropEvent({ files: [osFile("cell.png")] }));
      await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(i));
    }
    expect(fileNodes(s).map((n) => n.file)).toEqual(["assets/cell.png", "assets/cell 1.png", "assets/cell 2.png"]);
    expect(s.view.app.vault.createFolder).toHaveBeenCalledTimes(1);
  });

  test("two files of the same name in one drop do not collide", async () => {
    const s = setup();
    s.settings.attachmentFolder = "assets";
    s.images["app://assets/a.png"] = { width: 10, height: 10 };
    s.images["app://assets/a 1.png"] = { width: 10, height: 10 };
    s.handlers.drop(dropEvent({ files: [osFile("a.png"), osFile("a.png")] }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(2));
    expect([...s.written.keys()]).toEqual(["assets/a.png", "assets/a 1.png"]);
  });

  test("only the extensions a panel can show are saved; the rest are named in one Notice", async () => {
    const s = setup();
    s.images["app://attachments/ok.png"] = { width: 10, height: 10 };
    s.handlers.drop(dropEvent({ files: [osFile("notes.txt", "text/plain"), osFile("ok.png"), osFile("deck.key", "")] }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect([...s.written.keys()]).toEqual(["attachments/ok.png"]);
    expect(notices).toEqual(["Link Figures: skipped notes.txt, deck.key: not an image, PDF or TIFF file."]);
  });

  test("a drop of only unwanted files still says so, and inserts nothing", async () => {
    const s = setup();
    s.handlers.drop(dropEvent({ files: [osFile("notes.txt", "text/plain")] }));
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(fileNodes(s)).toHaveLength(0);
    expect(s.commits).toEqual([]);
  });

  test("a save that fails is reported and that file gets no node; the others are saved and inserted", async () => {
    const s = setup();
    s.images["app://attachments/good.png"] = { width: 10, height: 10 };
    s.view.app.vault.createBinary.mockRejectedValueOnce(new Error("disk full"));
    s.handlers.drop(dropEvent({ files: [osFile("bad.png"), osFile("good.png")] }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(fileNodes(s)[0].file).toBe("attachments/good.png");
    expect(notices).toEqual(["Link Figures: could not save bad.png. disk full"]);
  });

  test("a file saved but then not decodable is reported and gets no node (the file stays in the vault)", async () => {
    const s = setup();
    // `attachments/odd.png` is saved but not in `images`: it will not load.
    s.handlers.drop(dropEvent({ files: [osFile("odd.png")] }));
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(fileNodes(s)).toHaveLength(0);
    expect(notices[0]).toBe("Link Figures: attachments/odd.png could not be decoded, so it was not added.");
    expect(s.files["attachments/odd.png"]).toBe("BINARY");
  });

  test("a stale Obsidian draggable does not count when files came from the OS", async () => {
    const s = setup();
    s.images["app://attachments/real.png"] = { width: 10, height: 10 };
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/plot.png" } } };
    s.handlers.drop(dropEvent({ files: [osFile("real.png")] }));
    await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
    expect(fileNodes(s)[0].file).toBe("attachments/real.png");
  });
});

describe("images on the clipboard", () => {
  test("a pasted image is saved as 'Pasted image <timestamp>.png' and becomes a node", async () => {
    const s = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 27, 14, 5, 9));
    try {
      s.images["app://attachments/Pasted image 20261027140509.png"] = { width: 200, height: 100 };
      const ev = pasteEvent([{ kind: "file", type: "image/png", file: osFile("image.png", "image/png", [5]) }]);
      s.handlers.paste(ev);
      await vi.waitFor(() => expect(fileNodes(s)).toHaveLength(1));
      expect(ev.preventDefault).toHaveBeenCalled();
      expect([...s.written.keys()]).toEqual(["attachments/Pasted image 20261027140509.png"]);
      expect(fileNodes(s)[0].height).toBeCloseTo(NODE_WIDTH_PX / 2, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an image type we cannot show is named, not silently dropped", async () => {
    const s = setup();
    s.handlers.paste(pasteEvent([{ kind: "file", type: "image/heic", file: osFile("image.heic", "image/heic") }]));
    await vi.waitFor(() => expect(notices).toEqual(["Link Figures: skipped image.heic: not an image, PDF or TIFF file."]));
    expect(fileNodes(s)).toHaveLength(0);
  });
});

describe("the stage's events", () => {
  test("dragover is accepted as a copy", () => {
    const s = setup();
    const ev = dropEvent();
    s.handlers.dragover(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.dataTransfer.dropEffect).toBe("copy");
  });

  test("a figure that could not be read refuses drops and pastes, but keeps the window from opening the file", () => {
    const s = setup();
    s.view.readOnly = true;
    s.view.app.dragManager = { draggable: { type: "file", file: { path: "Notes/plot.png" } } };
    const over = dropEvent();
    s.handlers.dragover(over);
    expect(over.dataTransfer.dropEffect).toBe("none");
    const drop = dropEvent();
    s.handlers.drop(drop);
    expect(drop.preventDefault).toHaveBeenCalled();
    const paste = pasteEvent([{ kind: "string", type: "text/plain" }], "[[plot.png]]");
    s.handlers.paste(paste);
    expect(paste.preventDefault).not.toHaveBeenCalled();
    expect(fileNodes(s)).toHaveLength(0);
  });
});

describe("execute", () => {
  test("a page that has gone while the files were being saved gets nothing, and says so", async () => {
    const s = setup();
    const gone = { ...s.store.doc.pages[0], id: "pg-gone" };
    const ids = await s.intake.execute([{ kind: "link-file", path: "Notes/plot.png" }], { page: gone, x: 0, y: 0 }, []);
    expect(ids).toEqual([]);
    expect(fileNodes(s)).toHaveLength(0);
    expect(notices).toEqual(["Link Figures: the page was removed before the items could be added, so nothing was added."]);
  });

  test("no actions: nothing is committed", async () => {
    const s = setup();
    expect(await s.intake.execute([], { page: s.store.doc.pages[0], x: 0, y: 0 }, [])).toEqual([]);
    expect(s.commits).toEqual([]);
  });

  test("a very flat image still gets a box no smaller than the least a node may be", async () => {
    const s = setup();
    s.images["app://Notes/plot.png"] = { width: 100000, height: 1 };
    const ids = await s.intake.execute([{ kind: "link-file", path: "Notes/plot.png" }], { page: s.store.doc.pages[0], x: 0, y: 0 }, []);
    expect(ids).toHaveLength(1);
    expect(fileNodes(s)[0].height).toBeGreaterThanOrEqual(MM_TO_PX);
  });
});
