import { prepareCall, runCall, runInOneCommit } from "../../src/commands/headless";
import { panelCommands } from "../../src/commands/panels";
import { createApi, type OpenFigure } from "../../src/api";
import { MM_TO_PX } from "../../src/constants";
import { loadDocument } from "../../src/format/load";
import { emptyParsed, serializeFigureFile } from "../../src/format/serialize";
import { createDocument, textNodeDefaults } from "../../src/model/defaults";
import { createFigureStore } from "../../src/model/normalise";
import type { DocumentStore } from "../../src/model/store";
import type { Document, FileNode } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import { textNodeType } from "../../src/nodes/text-node";
import { createRegistries, type Registries } from "../../src/registry";
import type { CommandContext } from "../../src/registry/command";
import { normalizePath } from "../export/fake-vault";

// `obsidian` ships only typings, so this module cannot be loaded for real; the parts under test never touch it.
vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

const PATH = "figs/fig.lnkfig.md";

function registries(): Registries {
  const r = createRegistries();
  r.nodeTypes.register(fileNodeType);
  r.nodeTypes.register(textNodeType);
  for (const c of panelCommands()) r.commands.register(c);
  return r;
}

/** A figure with one A4 page (`pg-1`) and a label `t` on it at z 0. */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  doc.nodes.push(textNodeDefaults(doc.pages[0], { id: "t" }, []));
  return doc;
}

function openView(doc: Document, r: Registries): OpenFigure & { store: DocumentStore; selection: string[] } {
  let t = 0;
  const store = createFigureStore(doc, r, () => (t += 10_000));
  const view = {
    store,
    selection: [] as string[],
    commandContext: (): CommandContext => ({
      app: {} as never,
      registries: r,
      view: { file: { path: PATH }, selectedIds: () => view.selection, setSelection: (ids: string[]) => void (view.selection = ids) } as never,
      store,
      selection: view.selection,
      page: store.doc.pages[0],
    }),
  };
  return view;
}

function setup(options: { open?: boolean } = {}) {
  const r = registries();
  const text = new Map([[PATH, serializeFigureFile(figure(), emptyParsed())]]);
  const files = {
    read: async (path: string) => text.get(path)!,
    async process(path: string, edit: (t: string) => string) {
      text.set(path, edit(text.get(path)!));
    },
  };
  const view = options.open ? openView(figure(), r) : null;
  const api = createApi({ app: {} as never, registries: r, files, normalizePath, openFigure: (path) => (path === PATH ? view : null) });
  const doc = () => api.read(PATH);
  return { api, r, view, doc, saved: () => loadDocument(text.get(PATH)!).doc };
}

const panel = async (doc: Promise<Document>, id: string) => (await doc).nodes.find((n) => n.id === id) as FileNode;

describe("panel.create", () => {
  test("headless, links the file at the point, at the default size, above the page's nodes; the file is saved", async () => {
    const { api, saved } = setup();
    const { id } = (await api.run(PATH, "panel.create", { page: "pg-1", file: "Notes/plot.png", x: 10, y: 20 })) as { id: string };
    expect(id).toMatch(/^p-[a-z0-9]{4}$/);
    const node = saved().nodes.find((n) => n.id === id) as FileNode;
    expect(node).toMatchObject({ type: "file", page: "pg-1", file: "Notes/plot.png", subpath: "", show: "image", imageIndex: 0, x: 10, y: 20, z: 1 });
    expect(node.width).toBeCloseTo(0.4 * 210 * MM_TO_PX, 6);
    expect(node.height).toBeCloseTo(0.25 * 297 * MM_TO_PX, 6);
  });

  test.each([
    ["Notes/plot.png", "image"],
    ["Notes/scan.TIF", "image"],
    ["Notes/paper.pdf", "image"],
    ["Notes/analysis", "content"],
    ["Notes/analysis.md", "content"],
  ])("show defaults by the extension: %s → %s", async (file, show) => {
    const { api, doc } = setup();
    const { id } = (await api.run(PATH, "panel.create", { page: "pg-1", file, x: 0, y: 0 })) as { id: string };
    expect((await panel(doc(), id)).show).toBe(show);
  });

  test("the given subpath, show, imageIndex, size and id are kept", async () => {
    const { api, doc } = setup();
    const { id } = (await api.run(PATH, "panel.create", {
      id: "p-mine",
      page: "pg-1",
      file: "Notes/analysis",
      subpath: "#^fig-ab12",
      show: "image",
      imageIndex: 2,
      x: 5,
      y: 6,
      width: 120,
      height: 80,
    })) as { id: string };
    expect(id).toBe("p-mine");
    expect(await panel(doc(), "p-mine")).toMatchObject({ file: "Notes/analysis", subpath: "#^fig-ab12", show: "image", imageIndex: 2, x: 5, y: 6, width: 120, height: 80 });
  });

  test("a link that resolves to nothing still makes a panel (it shows as missing)", async () => {
    const { api, doc } = setup();
    const { id } = (await api.run(PATH, "panel.create", { page: "pg-1", file: "Nowhere/none", x: 0, y: 0 })) as { id: string };
    expect((await panel(doc(), id)).file).toBe("Nowhere/none");
  });

  test("in an open view the page defaults to the view's, the panel is selected, and it is one undo step", async () => {
    const { api, view } = setup({ open: true });
    const { id } = (await api.run(PATH, "panel.create", { file: "Notes/plot.png", x: 0, y: 0 })) as { id: string };
    expect(view!.store.doc.nodes.find((n) => n.id === id)?.page).toBe("pg-1");
    expect(view!.selection).toEqual([id]);
    view!.store.undo();
    expect(view!.store.doc).toEqual(figure());
  });

  test("several in one commit get distinct ids, rising z, and one undo step", () => {
    const r = registries();
    const view = openView(figure(), r);
    const call = (file: string) => prepareCall(r, { id: "panel.create", args: { file, x: 0, y: 0 } });
    const results = runInOneCommit(view.store, view.commandContext(), [call("a.png"), call("b.png"), call("c")], "insert") as { id: string }[];
    const ids = results.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
    const nodes = ids.map((id) => view.store.doc.nodes.find((n) => n.id === id)!);
    expect(nodes.map((n) => n.z)).toEqual([1, 2, 3]);
    view.store.undo();
    expect(view.store.doc).toEqual(figure());
  });

  test.each([
    ["an empty file", { page: "pg-1", file: "", x: 0, y: 0 }, /"file" must not be empty/],
    ["no file", { page: "pg-1", x: 0, y: 0 }, /"file" is required/],
    ["an unknown show", { page: "pg-1", file: "a.png", show: "both", x: 0, y: 0 }, /"show"/],
    ["a negative imageIndex", { page: "pg-1", file: "a.png", imageIndex: -1, x: 0, y: 0 }, /"imageIndex"/],
    ["a fractional imageIndex", { page: "pg-1", file: "a.png", imageIndex: 1.5, x: 0, y: 0 }, /"imageIndex"/],
    ["a zero width", { page: "pg-1", file: "a.png", x: 0, y: 0, width: 0 }, /"width"/],
    ["a negative height", { page: "pg-1", file: "a.png", x: 0, y: 0, height: -3 }, /"height"/],
    ["a number that is not finite", { page: "pg-1", file: "a.png", x: Infinity, y: 0 }, /"x"/],
    ["an id the figure has", { id: "t", page: "pg-1", file: "a.png", x: 0, y: 0 }, /already has a node "t"/],
    ["an empty id", { id: "", page: "pg-1", file: "a.png", x: 0, y: 0 }, /"id" must not be empty/],
    ["no page, headless", { file: "a.png", x: 0, y: 0 }, /needs "page"/],
    ["an unknown page", { page: "pg-9", file: "a.png", x: 0, y: 0 }, /no page "pg-9"/],
  ])("refuses %s and changes nothing", async (_what, args, message) => {
    const { api, saved } = setup();
    await expect(api.run(PATH, "panel.create", args)).rejects.toThrow(message);
    expect(saved()).toEqual(loadDocument(serializeFigureFile(figure(), emptyParsed())).doc);
  });

  test("a panel made directly in a store is the same as one made through the API", async () => {
    const r = registries();
    const store = createFigureStore(figure(), r);
    const ctx: CommandContext = { app: {} as never, registries: r, view: null, store, selection: [], page: undefined };
    await runCall(store, ctx, prepareCall(r, { id: "panel.create", args: { id: "p-x", page: "pg-1", file: "a.png", x: 1, y: 2 } }));
    expect(store.doc.nodes.find((n) => n.id === "p-x")).toMatchObject({ type: "file", file: "a.png", show: "image" });
  });
});
