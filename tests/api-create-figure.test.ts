import { createApi, type ApiHost } from "../src/api";
import { loadDocument } from "../src/format/load";
import { createRegistries } from "../src/registry";
import { CommandError } from "../src/registry/command";
import { newFigureText, writeNewFigureFile } from "../src/view/new-figure";
import { FakeTFile, FakeTFolder, normalizePath } from "./export/fake-vault";

vi.mock("obsidian", async () => {
  const fake = await import("./export/fake-vault");
  return { normalizePath: fake.normalizePath, TFile: fake.FakeTFile, TFolder: fake.FakeTFolder };
});

/** A vault with the parts `writeNewFigureFile` touches, recording what it does. */
function fakeApp(existing: Record<string, "file" | "folder"> = {}, onDisk: string[] = []) {
  const entries = new Map<string, FakeTFile | FakeTFolder>(
    Object.entries(existing).map(([p, kind]) => [p, kind === "file" ? new FakeTFile(p) : new FakeTFolder(p)]),
  );
  const written = new Map<string, string>();
  const calls: string[] = [];
  const vault = {
    getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
    adapter: { exists: async (path: string) => entries.has(path) || onDisk.includes(path) },
    async createFolder(path: string) {
      calls.push(`createFolder ${path}`);
      entries.set(path, new FakeTFolder(path));
    },
    async create(path: string, text: string) {
      calls.push(`create ${path}`);
      if (entries.has(path)) throw new Error("File already exists.");
      entries.set(path, new FakeTFile(path));
      written.set(path, text);
      return entries.get(path);
    },
  };
  return { app: { vault } as never, written, calls };
}

/** The API with a host that writes new figures into `fakeApp`'s vault. */
function setup(host: Partial<ApiHost> = {}, existing: Record<string, "file" | "folder"> = {}) {
  const vault = fakeApp(existing);
  const api = createApi({
    app: vault.app,
    registries: createRegistries(),
    files: { read: async () => "", process: async () => undefined },
    normalizePath,
    openFigure: () => null,
    createFigureFile: (path, text) => writeNewFigureFile(vault.app, path, text),
    defaultPreset: () => "a4-portrait",
    ...host,
  });
  const doc = (path: string) => loadDocument(vault.written.get(path)!).doc;
  return { api, ...vault, doc };
}

describe("api.createFigure", () => {
  test("writes a one-page figure of the default preset, as the New figure command does, and resolves to its path", async () => {
    const { api, written, doc } = setup();
    expect(await api.createFigure("figs/Fig 1.lnkfig.md")).toEqual({ path: "figs/Fig 1.lnkfig.md" });
    const made = doc("figs/Fig 1.lnkfig.md");
    expect(made.pages).toHaveLength(1);
    expect(made.pages[0]).toMatchObject({ name: "Page 1", preset: "a4-portrait", width: 210, height: 297 });
    expect(made.nodes).toEqual([]);
    // The same text the New figure command writes, but for the page's random id.
    const id = made.pages[0].id;
    expect(written.get("figs/Fig 1.lnkfig.md")).toBe(newFigureText("a4-portrait", 1).replace(/"id": "pg-[a-z0-9]{4}"/, `"id": "${id}"`));
  });

  test("appends .lnkfig.md when the path lacks it, and normalises the path", async () => {
    const { api, written } = setup();
    expect(await api.createFigure("/figs//Fig 2")).toEqual({ path: "figs/Fig 2.lnkfig.md" });
    expect(await api.createFigure("Fig 3.md")).toEqual({ path: "Fig 3.md.lnkfig.md" });
    expect([...written.keys()]).toEqual(["figs/Fig 2.lnkfig.md", "Fig 3.md.lnkfig.md"]);
  });

  test("a named preset and a number of pages", async () => {
    const { api, doc } = setup();
    await api.createFigure("a.lnkfig.md", { preset: "nature-double", pages: 3 });
    const made = doc("a.lnkfig.md");
    expect(made.pages.map((p) => [p.name, p.preset, p.width, p.height])).toEqual([
      ["Page 1", "nature-double", 183, 170],
      ["Page 2", "nature-double", 183, 170],
      ["Page 3", "nature-double", 183, 170],
    ]);
    expect(new Set(made.pages.map((p) => p.id)).size).toBe(3);
  });

  test("creates the folders above the file that are missing", async () => {
    const { api, calls } = setup({}, { a: "folder" });
    await api.createFigure("a/b/c/fig");
    expect(calls).toEqual(["createFolder a/b", "createFolder a/b/c", "create a/b/c/fig.lnkfig.md"]);
  });

  test.each([
    ["an existing file", { "fig.lnkfig.md": "file" as const }, "fig", /^createFigure: there is already a file or folder at "fig\.lnkfig\.md"/],
    ["an existing folder", { "fig.lnkfig.md": "folder" as const }, "fig", /already a file or folder/],
    ["a file where a folder would go", { figs: "file" as const }, "figs/fig", /^createFigure: "figs" is a file/],
  ])("refuses %s, writing nothing", async (_name, existing, path, message) => {
    const { api, calls } = setup({}, existing);
    const run = api.createFigure(path);
    await expect(run).rejects.toThrow(CommandError);
    await expect(run).rejects.toThrow(message);
    expect(calls.filter((c) => c.startsWith("create "))).toEqual([]);
  });

  test("refuses a path that only the disk has (not yet indexed)", async () => {
    const vault = fakeApp({}, ["fig.lnkfig.md"]);
    await expect(writeNewFigureFile(vault.app, "fig.lnkfig.md", "x")).rejects.toThrow(/already a file or folder/);
  });

  test.each([
    ["an unknown preset", "f", { preset: "x.poster" }, /^createFigure: there is no page preset "x\.poster"/],
    ["no pages", "f", { pages: 0 }, /^createFigure: "pages" must be a whole number from 1/],
    ["a fraction of a page", "f", { pages: 1.5 }, /"pages" must be a whole number/],
    ["pages as text", "f", { pages: "2" }, /"pages" must be a whole number/],
    ["an empty path", "  ", {}, /^createFigure: the path must name a file in the vault/],
    ["a path that is not text", 3, {}, /^createFigure: the path must name a file in the vault/],
    ["options that are not an object", "f", "a4-portrait", /^createFigure: the options must be an object/],
  ])("refuses %s, writing nothing", async (_name, path, options, message) => {
    const { api, calls } = setup();
    const run = api.createFigure(path as string, options as never);
    await expect(run).rejects.toThrow(CommandError);
    await expect(run).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  test("without a host that writes files, it rejects", async () => {
    const { api } = setup({ createFigureFile: undefined });
    await expect(api.createFigure("f")).rejects.toThrow(/createFigure: figures cannot be created here/);
  });

  test("without the default-preset setting, the default preset is Nature double column", async () => {
    const { api, doc } = setup({ defaultPreset: undefined });
    await api.createFigure("f");
    expect(doc("f.lnkfig.md").pages[0].preset).toBe("nature-double");
  });

  test("a default-preset setting that names no preset (stale) falls back, as the New figure command does", async () => {
    const { api, doc } = setup({ defaultPreset: () => "gone" });
    await api.createFigure("f");
    expect(doc("f.lnkfig.md").pages[0].preset).toBe("nature-double");
  });
});
