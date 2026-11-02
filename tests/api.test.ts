import { createApi, type OpenFigure } from "../src/api";
import { registerBuiltinCommands } from "../src/commands/builtin";
import { loadDocument } from "../src/format/load";
import { emptyParsed, serializeFigureFile } from "../src/format/serialize";
import { createDocument, textNodeDefaults } from "../src/model/defaults";
import { createFigureStore } from "../src/model/normalise";
import type { DocumentStore } from "../src/model/store";
import type { Document } from "../src/model/types";
import { createRegistries } from "../src/registry";
import { CommandError, type CommandContext } from "../src/registry/command";

const PATH = "figs/fig.lnkfig.md";

/** A figure with three labels, a (z 0), b (z 1) and c (z 2), on one page. */
function figure(): Document {
  const doc = createDocument("a4-portrait");
  ["a", "b", "c"].forEach((id, z) => doc.nodes.push({ ...textNodeDefaults(doc.pages[0], { id }, []), z }));
  return doc;
}

/** An open view of the figure, as the API sees one: its store, and the context its commands get. */
function openView(doc: Document, registries: ReturnType<typeof createRegistries>, now: () => number): OpenFigure & { store: DocumentStore; selection: string[] } {
  const store = createFigureStore(doc, registries, now);
  const view = {
    store,
    selection: [] as string[],
    commandContext: (): CommandContext => ({
      app: {} as never,
      registries,
      view: {
        file: { path: PATH },
        selectedIds: () => view.selection,
        setSelection: (ids: string[]) => { view.selection = ids; },
        pageLimitMm: () => 2000,
        notePageLimit: () => undefined,
      } as never,
      store,
      selection: view.selection,
      page: store.doc.pages[0],
    }),
  };
  return view;
}

function setup(options: { open?: boolean; now?: () => number } = {}) {
  const registries = createRegistries();
  registerBuiltinCommands({ registries, addCommand: () => undefined, activeFigureView: () => null } as never);
  const text = new Map([[PATH, serializeFigureFile(figure(), emptyParsed())]]);
  const log: string[] = [];
  const files = {
    async read(path: string) {
      log.push(`read ${path}`);
      const t = text.get(path);
      if (t === undefined) throw new CommandError(`there is no file "${path}"`);
      return t;
    },
    async write(path: string, t: string) {
      log.push(`write ${path}`);
      text.set(path, t);
    },
  };
  let t = 0;
  // By default commits far apart in time, so none merges into the one before.
  const view = options.open ? openView(figure(), registries, options.now ?? (() => (t += 10_000))) : null;
  const api = createApi({ app: {} as never, registries, files, openFigure: (path) => (path === PATH ? view : null) });
  const saved = () => loadDocument(text.get(PATH)!).doc;
  const ids = (doc: Document) => doc.nodes.map((n) => n.id);
  return { api, registries, view, log, text, saved, ids };
}

test("commands() lists every command with its params and whether it needs a view", () => {
  const { api, registries } = setup();
  const listed = api.commands();
  expect(listed.map((c) => c.id)).toEqual(registries.commands.all().map((c) => c.id));
  expect(listed.find((c) => c.id === "delete")).toEqual({ id: "delete", name: "Delete", group: "edit", params: { ids: { type: "array" } }, needsView: false });
  expect(listed.find((c) => c.id === "fit-page")).toEqual({ id: "fit-page", name: "Fit page", group: "view", needsView: true });
  // What a caller gets is a copy: changing it changes no command.
  listed.find((c) => c.id === "delete")!.params!.ids.required = true;
  expect(registries.commands.get("delete")!.params!.ids.required).toBeUndefined();
});

test("the API holds the plugin's registries", () => {
  const { api, registries } = setup();
  expect(api.registries).toBe(registries);
});

describe("headless (the figure is not open)", () => {
  test("run of a node command edits the file and saves it, and gives the command's result", async () => {
    const { api, log, saved, ids } = setup();
    await expect(api.run(PATH, "delete", { ids: ["b"] })).resolves.toEqual({ ids: ["b"] });
    expect(log).toEqual([`read ${PATH}`, `write ${PATH}`]);
    expect(ids(saved())).toEqual(["a", "c"]);
  });

  test("delete {ids} works without a view, and a call that changes nothing does not write the file", async () => {
    const { api, log, text } = setup();
    const before = text.get(PATH);
    await expect(api.run(PATH, "delete", { ids: [] })).resolves.toEqual({ ids: [] });
    expect(log).toEqual([`read ${PATH}`]);
    expect(text.get(PATH)).toBe(before);
  });

  test("a command that needs the view is refused, before the file is read", async () => {
    const { api, log } = setup();
    await expect(api.run(PATH, "fit-page")).rejects.toThrow(new CommandError("fit-page needs the figure to be open"));
    await expect(api.run(PATH, "fit-page")).rejects.toBeInstanceOf(CommandError);
    expect(log).toEqual([]);
  });

  test("bad arguments and unknown commands are refused with the parameter or command named", async () => {
    const { api, log } = setup();
    await expect(api.run(PATH, "delete", { ids: "b" })).rejects.toThrow('delete: parameter "ids" must be an array');
    await expect(api.run(PATH, "delete", { id: "b" })).rejects.toThrow('delete: unknown parameter "id"');
    await expect(api.run(PATH, "fit-page", { zoom: 2 })).rejects.toThrow(CommandError);
    await expect(api.run(PATH, "rotate")).rejects.toThrow('there is no command "rotate"');
    expect(log).toEqual([]);
  });

  test("a missing ids headless is an error, and the file is not written", async () => {
    const { api, log } = setup();
    await expect(api.run(PATH, "delete")).rejects.toThrow('delete needs "ids" when the figure is not open');
    expect(log).toEqual([`read ${PATH}`]);
  });

  test("a batch is saved once, all calls applied in order", async () => {
    const { api, log, saved, ids } = setup();
    const results = await api.batch(PATH, [
      { id: "delete", args: { ids: ["a"] } },
      { id: "bring-forward", args: { ids: ["b"] } },
    ]);
    expect(results).toEqual([{ ids: ["a"] }, null]);
    expect(log).toEqual([`read ${PATH}`, `write ${PATH}`]);
    const doc = saved();
    expect(ids(doc)).toEqual(["b", "c"]);
    expect(Object.fromEntries(doc.nodes.map((n) => [n.id, n.z]))).toEqual({ b: 2, c: 1 });
  });

  test("a batch that fails is not saved at all", async () => {
    const { api, log, text } = setup();
    const before = text.get(PATH);
    await expect(
      api.batch(PATH, [
        { id: "delete", args: { ids: ["a"] } },
        { id: "bring-forward", args: { ids: ["b"] } },
        { id: "delete", args: { ids: ["missing"] } },
      ]),
    ).rejects.toThrow('delete: there is no node "missing"');
    expect(log).toEqual([`read ${PATH}`]);
    expect(text.get(PATH)).toBe(before);
  });

  test("calls that are not awaited one by one still all land", async () => {
    const { api, saved, ids } = setup();
    await Promise.all([api.run(PATH, "delete", { ids: ["a"] }), api.run(PATH, "delete", { ids: ["b"] })]);
    expect(ids(saved())).toEqual(["c"]);
  });

  test("read gives the file's document", async () => {
    const { api, ids } = setup();
    expect(ids(await api.read(PATH))).toEqual(["a", "b", "c"]);
  });

  test("a path with no file is refused", async () => {
    const { api } = setup();
    await expect(api.run("nope.lnkfig.md", "delete", { ids: [] })).rejects.toThrow('there is no file "nope.lnkfig.md"');
  });
});

describe("on an open view", () => {
  test("run acts on the view's store, as one undo step, and never touches the file", async () => {
    const { api, view, log, ids } = setup({ open: true });
    await api.run(PATH, "delete", { ids: ["a"] });
    expect(ids(view!.store.doc)).toEqual(["b", "c"]);
    expect(log).toEqual([]);
    view!.store.undo();
    expect(ids(view!.store.doc)).toEqual(["a", "b", "c"]);
  });

  test("without ids, a command acts on the view's selection", async () => {
    const { api, view, ids } = setup({ open: true });
    view!.selection = ["c"];
    await api.run(PATH, "delete");
    expect(ids(view!.store.doc)).toEqual(["a", "b"]);
  });

  test("a successful batch is one undo step", async () => {
    const { api, view, ids } = setup({ open: true });
    const store = view!.store;
    const results = await api.batch(PATH, [
      { id: "delete", args: { ids: ["a"] } },
      { id: "duplicate", args: { ids: ["b"] } },
      { id: "send-backward", args: { ids: ["c"] } },
    ]);
    expect(results[0]).toEqual({ ids: ["a"] });
    expect(ids(store.doc)).toHaveLength(3);
    expect(store.undo()).toBe(true);
    expect(ids(store.doc)).toEqual(["a", "b", "c"]);
    expect(store.canUndo()).toBe(false);
  });

  test("calls in quick succession are undo steps of their own, even with the label of the edit before", async () => {
    const { api, view, ids } = setup({ open: true, now: () => 0 });
    const store = view!.store;
    store.commit("delete", (d) => { d.nodes = d.nodes.filter((n) => n.id !== "a"); });
    await api.run(PATH, "delete", { ids: ["b"] });
    await api.batch(PATH, [{ id: "delete", args: { ids: ["c"] } }]);
    await api.batch(PATH, [{ id: "add-page" }]);
    store.commit("delete", (d) => { d.pages[0].name = "x"; });
    const steps: string[][] = [];
    while (store.undo()) steps.push(ids(store.doc));
    expect(steps).toEqual([[], [], ["c"], ["b", "c"], ["a", "b", "c"]]);
  });

  test("Review Focus 4: a batch whose third call fails leaves the document and the undo stack untouched", async () => {
    const { api, view } = setup({ open: true });
    const store = view!.store;
    store.commit("rename", (d) => { d.pages[0].name = "Panel A"; });
    const before = store.doc;
    const events: string[] = [];
    store.subscribe((ev) => events.push(ev.kind));
    await expect(
      api.batch(PATH, [
        { id: "delete", args: { ids: ["a"] } },
        { id: "bring-forward", args: { ids: ["b"] } },
        { id: "duplicate", args: { ids: ["missing"] } },
      ]),
    ).rejects.toThrow(CommandError);
    expect(store.doc).toBe(before);
    expect(events).toEqual([]);
    expect(store.canRedo()).toBe(false);
    // The one entry on the stack is the rename from before the batch.
    expect(store.undo()).toBe(true);
    expect(store.doc.pages[0].name).toBe("Page 1");
    expect(store.doc.nodes).toEqual(before.nodes);
    expect(store.canUndo()).toBe(false);
  });

  test("a batch whose third call has bad arguments runs none of them", async () => {
    const { api, view } = setup({ open: true });
    const before = view!.store.doc;
    await expect(
      api.batch(PATH, [
        { id: "delete", args: { ids: ["a"] } },
        { id: "delete", args: { ids: ["b"] } },
        { id: "delete", args: { ids: 3 } },
      ]),
    ).rejects.toThrow('delete: parameter "ids" must be an array');
    expect(view!.store.doc).toBe(before);
    expect(view!.store.canUndo()).toBe(false);
  });

  test("undo cannot run inside a batch, and a command that does not finish at once cannot either", async () => {
    const { api, view, registries } = setup({ open: true });
    registries.commands.register({ id: "slow", name: "Slow", group: "edit", applies: () => true, run: async () => undefined });
    const before = view!.store.doc;
    await expect(api.batch(PATH, [{ id: "delete", args: { ids: ["a"] } }, { id: "undo" }])).rejects.toThrow("undo cannot run inside a batch");
    await expect(api.batch(PATH, [{ id: "delete", args: { ids: ["a"] } }, { id: "slow" }])).rejects.toThrow("slow cannot run in a batch");
    expect(view!.store.doc).toBe(before);
  });

  test("a batch must be an array of calls", async () => {
    const { api } = setup({ open: true });
    await expect(api.batch(PATH, { id: "delete" } as never)).rejects.toThrow(CommandError);
    await expect(api.batch(PATH, [{ args: {} }] as never)).rejects.toThrow(CommandError);
  });

  test("read gives the view's current document, as a copy", async () => {
    const { api, view, log } = setup({ open: true });
    view!.store.commit("delete", (d) => { d.nodes = d.nodes.filter((n) => n.id !== "a"); });
    const doc = await api.read(PATH);
    expect(doc).toEqual(view!.store.doc);
    expect(doc).not.toBe(view!.store.doc);
    doc.nodes.pop();
    expect(view!.store.doc.nodes).toHaveLength(2);
    expect(log).toEqual([]);
  });
});
