import { builtinCapKinds, builtinRoutes } from "../../src/connectors/builtin";
import type { FileRef, Range, VaultAccess } from "../../src/links/types";
import { connectorNodeDefaults, createDocument, createPage } from "../../src/model/defaults";
import { mmToPx } from "../../src/model/geometry";
import type { CardNode, Document, Node, Page } from "../../src/model/types";
import { cardNodeDefaults, cardNodeType } from "../../src/nodes/card-node";
import { connectorNodeType } from "../../src/nodes/connector-node";
import { createRegistries } from "../../src/registry";
import type { Exporter } from "../../src/registry/exporter";
import { fakeVault, FakeTFile } from "./fake-vault";

vi.mock("obsidian", async () => {
  const fake = await import("./fake-vault");
  return { normalizePath: fake.normalizePath, TFile: fake.FakeTFile, Modal: class {}, Notice: class {}, Setting: class {}, Component: class {}, MarkdownRenderer: {}, setIcon: () => {} };
});
vi.mock("../../src/links/decoders/pdf", () => ({ decodePdf: vi.fn(), pdfPageSizePt: vi.fn() }));
const { cardsForPage, cardMarkdown, cardTextSource, expandEmbeds, rewriteImages, imageCopier, readNoteSection } = await import("../../src/export/cards-markdown");
const { markdownToPlainText } = await import("../../src/export/markdown-text");
const { runExport, exportInBackground } = await import("../../src/export/export-run");
const { isFigureSource } = await import("../../src/export/write");
const { createApi } = await import("../../src/api");

const MM = mmToPx(1);

function registries() {
  const r = createRegistries();
  for (const t of [connectorNodeType, cardNodeType]) r.nodeTypes.register(t);
  for (const rt of builtinRoutes) r.routes.register(rt);
  for (const c of builtinCapKinds) r.caps.register(c);
  return r;
}

/** A card beside `page` (x, y in mm, page-relative), with `content` (text, or a note link), tied to `tied` pages. */
function card(doc: Document, id: string, page: Page, x: number, y: number, content: Partial<CardNode>): CardNode {
  const c = { ...cardNodeDefaults(page, x * MM, y * MM), id, ...content } as CardNode;
  if (c.file !== undefined) delete c.text;
  doc.nodes.push(c);
  return c;
}

let ties = 0;
function tie(doc: Document, c: Node, page: Page): void {
  doc.nodes.push(connectorNodeDefaults(doc.pages.find((p) => p.id === c.page)!, { id: `tie${++ties}`, ends: [{ kind: "attached", node: c.id, snap: "center" }, { kind: "page", page: page.id }] }, []));
}

/** Three A4 pages, ids pg-1..pg-3, named Page 1..3. */
function pages(): Document {
  const doc = createDocument("a4-portrait");
  doc.pages[0].id = "pg-1";
  doc.pages.push({ ...createPage("a4-portrait", ["pg-1"]), id: "pg-2" }, { ...createPage("a4-portrait", ["pg-1", "pg-2"]), id: "pg-3" });
  return doc;
}

const NOTE = "# Legend\n\nIntro\n\n## Fig 1\n\nPanel **A**: cortex.\n![[img/plot.png]]\n\n## Fig 2\n\nOther\n";

/** A vault of notes and images as `VaultAccess` sees it: a link resolves by full path, or by name with `.md` added. */
function access(files: Record<string, string | Uint8Array> = { "Notes/Legend.md": NOTE, "img/plot.png": new Uint8Array([1]), "sub/plot.png": new Uint8Array([2]) }) {
  const reads: string[] = [];
  const ref = (path: string): FileRef => ({ path, extension: path.slice(path.lastIndexOf(".") + 1) });
  const a: VaultAccess = {
    resolveLink(path) {
      const hit = Object.keys(files).find((f) => f === path || f === `${path}.md` || f.endsWith(`/${path}`) || f.endsWith(`/${path}.md`));
      return hit ? ref(hit) : null;
    },
    sectionRange(file, subpath): Range | null {
      if (subpath === "") return { start: 0, end: null };
      const text = String(files[file.path]);
      const heading = subpath.replace(/^#/, "");
      const m = new RegExp(`^(#+) ${heading}$`, "m").exec(text);
      if (!m) return null;
      const rest = text.slice(m.index + m[0].length);
      const next = new RegExp(`^#{1,${m[1].length}} `, "m").exec(rest);
      return { start: m.index, end: next ? m.index + m[0].length + next.index : null };
    },
    embedsIn: () => [],
    async readText(file) {
      reads.push(file.path);
      return String(files[file.path]);
    },
    async readBinary(file) {
      const bytes = files[file.path] as Uint8Array;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    resourcePath: () => "",
  };
  return { access: a, reads };
}

/** An exporter that writes one file per page, recording nothing else. */
const spy: Exporter = {
  id: "spy",
  name: "Spy",
  ext: "txt",
  mime: "text/plain",
  pdfPanels: "raster",
  options: () => [],
  async run(input) {
    return { files: input.pages.map((p) => ({ name: `${input.baseName} - ${p.name}.txt`, blob: new Blob([p.name]) })), warnings: [] };
  },
};

function world() {
  const vault = fakeVault();
  const app = { vault: { ...vault, getFileByPath: (path: string) => (vault.entries.get(path) instanceof FakeTFile ? vault.entries.get(path) : null) } };
  return { vault, app: app as never };
}

const text = (data: ArrayBuffer | undefined) => new TextDecoder().decode(data);
/** Never a figure file, a dependency or a note, except the cards file, which may be written. */
const guard = (path: string, cardsFile?: boolean) => isFigureSource(path, "Figs/Fig.lnkfig.md", () => false, cardsFile);

async function exportCards(doc: Document, over: { cards?: boolean; files?: Record<string, string | Uint8Array>; pages?: Page[] } = {}) {
  const { vault, app } = world();
  const vaultAccess = access(over.files);
  const out = await runExport(
    { exporter: spy, doc, pages: over.pages ?? doc.pages, baseName: "Fig", folder: "out", dpi: 300, maxPageSizeMm: 2000, cards: over.cards ?? true, figurePath: "Figs/Fig.lnkfig.md" },
    { app, registries: registries(), resolved: () => undefined, elementFor: () => undefined, decoders: {} as never, trim: {} as never, isProtected: guard, access: vaultAccess.access },
  );
  return { out, vault, reads: vaultAccess.reads };
}

describe("cardsForPage", () => {
  test("the cards tied to the page, by rows (tops within 5 mm), then left to right", () => {
    const doc = pages();
    const [p1, p2] = doc.pages;
    const low = card(doc, "low", p1, 220, 50, { text: "Low" });
    const top = card(doc, "top", p1, 220, 10, { text: "Top" });
    const right = card(doc, "right", p1, 290, 14, { text: "Right" });
    const other = card(doc, "other", p1, 220, 120, { text: "Other" });
    for (const c of [low, top, right]) tie(doc, c, p1);
    tie(doc, other, p2);
    const r = registries();
    expect(cardsForPage(doc, r, "pg-1").map((c) => c.id)).toEqual(["top", "right", "low"]);
    expect(cardsForPage(doc, r, "pg-2").map((c) => c.id)).toEqual(["other"]);
    expect(cardsForPage(doc, r, "pg-3")).toEqual([]);
  });
});

describe("cardMarkdown and rewriteImages", () => {
  test("a note card gives the linked heading's section", async () => {
    const doc = pages();
    const c = card(doc, "n", doc.pages[0], 220, 10, { file: "Notes/Legend", subpath: "#Fig 1" });
    const { access: a } = access();
    const out = await cardMarkdown(c, { readNote: (file, subpath) => readNoteSection(a, file, subpath, "Figs/Fig.lnkfig.md") });
    expect(out).toEqual({ markdown: "## Fig 1\n\nPanel **A**: cortex.\n![[img/plot.png]]", sourcePath: "Notes/Legend.md", warnings: [] });
  });

  test("a whole note leaves its front matter out", async () => {
    const doc = pages();
    const c = card(doc, "n", doc.pages[0], 220, 10, { file: "Plain" });
    const { access: a } = access({ "Plain.md": "---\ntags: [x]\n---\nBody\n" });
    const out = await cardMarkdown(c, { readNote: (file, subpath) => readNoteSection(a, file, subpath, "Figs/Fig.lnkfig.md") });
    expect(out.markdown).toBe("Body");
  });

  test("embeds are copied once each, a second file of the same name becomes -2, and what cannot be copied is kept with a warning", async () => {
    const written: string[] = [];
    const copy = imageCopier("Fig - Page 1 cards", async (name, file) => {
      written.push(`${file.path} -> ${name}`);
      return true;
    });
    const { access: a } = access({ "img/plot.png": new Uint8Array([1]), "sub/plot.png": new Uint8Array([2]), "Other.md": "x" });
    const out = await rewriteImages("A ![[img/plot.png]] B ![[sub/plot.png|200]] C ![alt](img/plot.png) D ![[gone.png]] E ![[Other]] F ![](https://x.org/a.png)", {
      label: '"c"',
      resolve: (link) => a.resolveLink(link, "Figs/Fig.lnkfig.md"),
      copy,
    });
    expect(out.markdown).toBe(
      "A ![](<Fig - Page 1 cards/plot.png>) B ![](<Fig - Page 1 cards/plot-2.png>) C ![alt](<Fig - Page 1 cards/plot.png>) D ![[gone.png]] E ![[Other]] F ![](https://x.org/a.png)",
    );
    expect(written).toEqual(["img/plot.png -> plot.png", "sub/plot.png -> plot-2.png"]);
    expect(out.warnings).toEqual(['"c": the image "gone.png" was not found; its link is kept', '"c": the embed "Other" is not an image; its link is kept']);
  });

  test("with quietNotes, a wikilink note embed (reported by the expansion) is quiet; a Markdown-form one keeps its warning", async () => {
    const { access: a } = access({ "Other.md": "x" });
    const out = await rewriteImages("E ![[Other]] F ![](Other.md) G ![[Gone]]", {
      label: '"c"',
      resolve: (link) => a.resolveLink(link, "Figs/Fig.lnkfig.md"),
      copy: async () => null,
      quietNotes: true,
    });
    expect(out.markdown).toBe("E ![[Other]] F ![](Other.md) G ![[Gone]]");
    expect(out.warnings).toEqual(['"c": the embed "Other.md" is not an image; its link is kept']);
  });

  test("embeds in fenced code blocks and inline code are left as they are", async () => {
    const copied: string[] = [];
    const { access: a } = access({ "img/plot.png": new Uint8Array([1]) });
    const md = "`![[img/plot.png]]` and ``x ![](img/plot.png) y``\n\n```md\n![[img/plot.png]]\n```\n\n~~~\n![a](img/plot.png)\n~~~\n\n![[img/plot.png]]";
    const out = await rewriteImages(md, {
      label: '"c"',
      resolve: (link) => a.resolveLink(link, "Figs/Fig.lnkfig.md"),
      copy: async (file) => {
        copied.push(file.path);
        return "d/plot.png";
      },
    });
    expect(out.markdown).toBe(md.replace(/!\[\[img\/plot\.png\]\]$/, "![](<d/plot.png>)"));
    expect(copied).toEqual(["img/plot.png"]);
    expect(out.warnings).toEqual([]);
  });

  test("a stray backtick does not pair with one in a later paragraph: the embed between them is rewritten", async () => {
    const md = "a stray ` here\n\n![[a.png]]\n\nand ` there";
    const out = await rewriteImages(md, { label: '"c"', resolve: (link) => ({ path: link, extension: "png" }), copy: async (file) => `d/${file.path}` });
    expect(out.markdown).toBe("a stray ` here\n\n![](<d/a.png>)\n\nand ` there");
  });

  test("an unclosed code fence runs to the end: nothing after it is rewritten", async () => {
    const md = "![[a.png]]\n```\n![[b.png]]";
    const out = await rewriteImages(md, { label: '"c"', resolve: (link) => ({ path: link, extension: "png" }), copy: async (file) => `d/${file.path}` });
    expect(out.markdown).toBe("![](<d/a.png>)\n```\n![[b.png]]");
  });
});

describe("export: cards as Markdown", () => {
  test("a cards file whose first card starts with `---` begins with a blank line, so it is not read as front matter", async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "---\ntitle: x\n---\nBody" });
    tie(doc, c, doc.pages[0]);
    const { vault } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("\n---\ntitle: x\n---\nBody\n");
  });

  test("a page with two cards writes `<figure> - <page> cards.md` with both, in row order, separated by `\\n\\n---\\n\\n`", async () => {
    const doc = pages();
    const p1 = doc.pages[0];
    const second = card(doc, "second", p1, 220, 60, { text: "Second card" });
    const first = card(doc, "first", p1, 220, 10, { text: "First card" });
    tie(doc, second, p1);
    tie(doc, first, p1);
    const { out, vault } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("First card\n\n---\n\nSecond card\n");
    expect(out.paths).toContain("out/Fig - Page 1 cards.md");
    expect(out.warnings).toEqual([]);
  });

  test("an embedded image is copied into `<figure> - <page> cards/` and the link rewritten; a second image of the same name becomes `-2`", async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "![[img/plot.png]]\n![[sub/plot.png]]" });
    tie(doc, c, doc.pages[0]);
    const { vault, out } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("![](<Fig - Page 1 cards/plot.png>)\n![](<Fig - Page 1 cards/plot-2.png>)\n");
    expect([...new Uint8Array(vault.content.get("out/Fig - Page 1 cards/plot.png")!)]).toEqual([1]);
    expect([...new Uint8Array(vault.content.get("out/Fig - Page 1 cards/plot-2.png")!)]).toEqual([2]);
    expect(out.paths).toEqual(["out/Fig - Page 1.txt", "out/Fig - Page 2.txt", "out/Fig - Page 3.txt", "out/Fig - Page 1 cards/plot.png", "out/Fig - Page 1 cards/plot-2.png", "out/Fig - Page 1 cards.md"]);
  });

  test("a note card gives its section, and its images resolve from the note", async () => {
    const doc = pages();
    const c = card(doc, "n", doc.pages[0], 220, 10, { file: "Notes/Legend", subpath: "#Fig 1" });
    tie(doc, c, doc.pages[0]);
    const { vault } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("## Fig 1\n\nPanel **A**: cortex.\n![](<Fig - Page 1 cards/plot.png>)\n");
  });

  test('a missing note: warning `"<card>": its note "<file>" was not found; the card is left out` and the rest is still written', async () => {
    const doc = pages();
    const p1 = doc.pages[0];
    const gone = card(doc, "gone", p1, 220, 10, { file: "Deleted" });
    const noHeading = card(doc, "noHeading", p1, 220, 60, { file: "Notes/Legend", subpath: "#Fig 9" });
    const kept = card(doc, "kept", p1, 220, 110, { text: "Kept" });
    for (const c of [gone, noHeading, kept]) tie(doc, c, p1);
    const { vault, out } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("Kept\n");
    expect(out.warnings).toEqual(['"gone": its note "Deleted" was not found; the card is left out', '"noHeading": its note "Notes/Legend#Fig 9" was not found; the card is left out']);
  });

  test("a missing image: warning, link text kept", async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "See ![[gone.png]]" });
    tie(doc, c, doc.pages[0]);
    const { vault, out } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("See ![[gone.png]]\n");
    expect(out.warnings).toEqual(['"c": the image "gone.png" was not found; its link is kept']);
  });

  test("a card tied to two exported pages appears in both files", async () => {
    const doc = pages();
    const [p1, p2] = doc.pages;
    const both = card(doc, "both", p1, 220, 10, { text: "Both" });
    tie(doc, both, p1);
    tie(doc, both, p2);
    const { vault } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("Both\n");
    expect(text(vault.content.get("out/Fig - Page 2 cards.md"))).toBe("Both\n");
    // Only the exported pages: page 2 alone writes page 2's file.
    const only = await exportCards(doc, { pages: [p2] });
    expect([...only.vault.content.keys()].filter((p) => p.endsWith(".md"))).toEqual(["out/Fig - Page 2 cards.md"]);
  });

  test("a page with no cards writes no file", async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "One" });
    tie(doc, c, doc.pages[0]);
    card(doc, "untied", doc.pages[1], 220, 10, { text: "Untied" });
    const { vault } = await exportCards(doc);
    expect([...vault.content.keys()].filter((p) => p.endsWith(".md"))).toEqual(["out/Fig - Page 1 cards.md"]);
  });

  test("the option off writes nothing", async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { file: "Notes/Legend", subpath: "#Fig 1" });
    tie(doc, c, doc.pages[0]);
    const { vault, reads } = await exportCards(doc, { cards: false });
    expect([...vault.content.keys()]).toEqual(["out/Fig - Page 1.txt", "out/Fig - Page 2.txt", "out/Fig - Page 3.txt"]);
    expect(reads).toEqual([]);
  });

  test("the note a card reads, the figure and its sources are never written over", () => {
    expect(guard("out/Fig - Page 1 cards.md", true)).toBe(false);
    expect(guard("out/Fig - Page 1 cards.md")).toBe(true);
    expect(guard("Figs/Fig.lnkfig.md", true)).toBe(true);
    expect(isFigureSource("Data/x.md", "Figs/Fig.lnkfig.md", (p) => p === "Data/x.md", true)).toBe(true);
  });

  test("api.export of a closed figure reads note cards from the vault", async () => {
    const doc = pages();
    const c = card(doc, "n", doc.pages[0], 220, 10, { file: "Notes/Legend", subpath: "#Fig 1" });
    tie(doc, c, doc.pages[0]);
    const r = registries();
    r.exporters.register(spy);
    const { vault, app } = world();
    const { access: a, reads } = access();
    // The background view has drawn nothing: nothing is resolved on its stage, and no element is there.
    const resolved = vi.fn(() => undefined);
    const target = {
      figurePath: "Figs/Fig.lnkfig.md",
      baseName: "Fig",
      doc,
      currentPage: doc.pages[0],
      settings: { exportFolder: "out", exportDpi: 300, maxPageSizeMm: 2000 },
      deps: { app, registries: r, resolved, elementFor: () => undefined, decoders: {} as never, trim: {} as never, isProtected: guard, access: a },
    };
    const host = { registries: r, settings: { exportDpi: 300 }, read: async () => doc, open: async () => ({ target, drawn: async () => {}, close: () => {} }) };
    const api = createApi({
      app: {} as never,
      registries: r,
      files: {} as never,
      normalizePath: (p) => p,
      openFigure: () => null,
      exportFigure: (path, request) => exportInBackground(host, path, request),
    });
    const out = await api.export("Figs/Fig.lnkfig.md", { format: "spy", options: { cards: "markdown" } });
    expect(out.files).toContain("out/Fig - Page 1 cards.md");
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toContain("Panel **A**: cortex.");
    expect(reads).toEqual(["Notes/Legend.md"]);
    expect(resolved).not.toHaveBeenCalledWith("n");
  });

  test("options.cards takes only \"markdown\"", async () => {
    const r = registries();
    r.exporters.register(spy);
    const api = createApi({ app: {} as never, registries: r, files: {} as never, normalizePath: (p) => p, openFigure: () => null, exportFigure: async () => ({ files: [], warnings: [] }) });
    await expect(api.export("F.lnkfig.md", { format: "spy", options: { cards: "html" } })).rejects.toThrow('api.export: option "cards" must be "markdown"');
  });
});

describe("links and embeds in a text card", () => {
  test("`![[note#h]]` in a text card exports the section, one level deep", async () => {
    const doc = pages();
    const files = {
      "Notes/Legend.md": "# Legend\n\n## Fig 1\n\nPanel **A** ![[img/plot.png]] and ![[Inner]]\n\n## Fig 2\n\nOther\n",
      "Notes/Inner.md": "Inner text ![[Notes/Legend#Fig 1]]",
      "img/plot.png": new Uint8Array([1]),
    };
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "Figure 1.\n\n![[Legend#Fig 1]]\n\n`![[Legend]]` stays" });
    tie(doc, c, doc.pages[0]);
    const { vault, out } = await exportCards(doc, { files });
    // The section in place of its embed; its image copied (resolved from the note); the embed inside it kept, not expanded.
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe(
      "Figure 1.\n\n## Fig 1\n\nPanel **A** ![](<Fig - Page 1 cards/plot.png>) and ![[Inner]]\n\n`![[Legend]]` stays\n",
    );
    // The embed one level down is kept, said once (by the expansion, not again as "not an image").
    expect(out.warnings).toEqual(['"c": the embed "Inner" inside "Legend#Fig 1" is not expanded (one level only); its embed is kept']);
    // The expansion alone: one level, and a missing section keeps its embed.
    const { access: a } = access(files);
    const readNote = (file: string, subpath: string) => readNoteSection(a, file, subpath, "Figs/Fig.lnkfig.md");
    const resolve = (link: string, fromPath: string) => a.resolveLink(link, fromPath);
    const once = await expandEmbeds("![[Inner]] and ![[Legend#Fig 9]]", readNote, { resolve, fromPath: "Figs/Fig.lnkfig.md" });
    expect(once.markdown).toBe("Inner text ![[Notes/Legend#Fig 1]] and ![[Legend#Fig 9]]");
    expect(once.warnings).toEqual([
      'the embed "Notes/Legend#Fig 1" inside "Inner" is not expanded (one level only); its embed is kept',
      'the section "Legend#Fig 9" was not found; its embed is kept',
    ]);
  });

  test("`[[link|shown]]` exports `shown`", async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "See [[Notes/Legend#Fig 1|shown]], [[Notes/Legend#Fig 2]] and `[[code]]`" });
    tie(doc, c, doc.pages[0]);
    const { vault } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("See shown, Notes/Legend > Fig 2 and `[[code]]`\n");
  });

  test("the notes text of an embed is its plain text", async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "Legend:\n\n![[Notes/Legend#Fig 1]]" });
    tie(doc, c, doc.pages[0]);
    const { access: a } = access();
    const texts = cardTextSource({ doc, registries: registries(), figurePath: "Figs/Fig.lnkfig.md", access: a }, []);
    const [only] = await texts("pg-1");
    expect(markdownToPlainText(only.markdown)).toBe("Legend:\n\nFig 1\n\nPanel A: cortex.");
  });
});

describe("embeds that are kept", () => {
  test('a note found without its section: `the section "X#h" was not found; its embed is kept`, said once', async () => {
    const doc = pages();
    const c = card(doc, "c", doc.pages[0], 220, 10, { text: "Before\n\n![[Legend#Fig 9]]\n\n![[Nowhere]]" });
    tie(doc, c, doc.pages[0]);
    const { vault, out } = await exportCards(doc);
    expect(text(vault.content.get("out/Fig - Page 1 cards.md"))).toBe("Before\n\n![[Legend#Fig 9]]\n\n![[Nowhere]]\n");
    expect(out.warnings).toEqual(['"c": the section "Legend#Fig 9" was not found; its embed is kept', '"c": the note "Nowhere" was not found; its embed is kept']);
  });
});
