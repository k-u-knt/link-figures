// Security: values from a figure file must not break out of the attributes they are written into in an exported SVG.
import { buildPageSvg } from "../../src/export/svg-builder";
import { migrate } from "../../src/format/migrate";
import { FormatError } from "../../src/format/errors";
import { createDocument, createPage, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode, Node } from "../../src/model/types";
import { fileNodeType } from "../../src/nodes/file-node";
import { fileNodeSvg } from "../../src/nodes/file-node-svg";
import { createRegistries } from "../../src/registry";

vi.mock("obsidian", () => ({ Component: class {}, MarkdownRenderer: {}, setIcon: () => {} }));

const page = createPage("a4-portrait", []);
const fileNode = (over: Partial<FileNode> = {}): FileNode => ({
  ...fileNodeDefaults(page, { file: "plot.svg", subpath: "", show: "image" }, []),
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  ...over,
});
const svgCtx = () => ({
  registries: createRegistries(),
  doc: { ...createDocument("a4-portrait"), pages: [page] },
  page,
  assets: new Map(),
  defs: [] as string[],
  warnings: [] as string[],
  uid: (p: string) => p + "-1",
});
const SVG = { kind: "svg" as const, text: '<svg viewBox="0 0 10 10"><style>.a{fill:red}</style><rect class="a" id="r"/></svg>', width: 10, height: 10 };

describe("F3: a file node's id in a nested SVG", () => {
  test("a quote in the id cannot add attributes to the nested <svg>", () => {
    const n = fileNode({ id: 'a" onload="alert(1)" data-x="' });
    const out = fileNodeSvg(n, SVG, svgCtx()) as string;
    expect(out).not.toMatch(/\sonload=/);
    expect(out).not.toContain('"a"');
    // Every id the nested file gets stays inside its quotes.
    for (const m of out.matchAll(/\sid="([^"]*)"/g)) expect(m[1]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("an id with markup characters cannot open a tag in the scoped <style>", () => {
    const n = fileNode({ id: "x</style><script>alert(1)</script>" });
    const out = fileNodeSvg(n, SVG, svgCtx()) as string;
    expect(out).not.toContain("<script");
    expect(out.match(/<style>([\s\S]*?)<\/style>/)?.[1]).not.toContain("<");
  });

  test("an ordinary id is used as it is", () => {
    const n = fileNode({ id: "p-3f9a" });
    expect(fileNodeSvg(n, SVG, svgCtx())).toContain('id="p-3f9a-root"');
  });
});

describe("F10: rotation, opacity and z of a node", () => {
  const body = (extra: Record<string, unknown>) => ({
    version: 1,
    pages: [{ id: "pg-1", name: "Page 1", width: 183, height: 170, paper: "#ffffff", margins: { top: 0, right: 0, bottom: 0, left: 0 }, grid: { spacing: 5, show: false } }],
    nodes: [{ id: "p-1", type: "file", page: "pg-1", x: 0, y: 0, width: 10, height: 10, ...extra }],
  });

  test.each([
    ["rotation", '0)"/><script>alert(1)</script><g x="('],
    ["opacity", '0.5"/><script>alert(1)</script><g x="'],
    ["z", "1; drop"],
    ["rotation", Number.NaN],
    ["opacity", Infinity],
  ])("migrate refuses a %s that is not a finite number", (key, value) => {
    expect(() => migrate(body({ [key]: value }))).toThrow(FormatError);
  });

  test("migrate refuses it on a node of a type no plugin registers too", () => {
    const b = body({});
    b.nodes[0] = { ...b.nodes[0], type: "plugin:thing", rotation: "0)<script>" } as never;
    expect(() => migrate(b)).toThrow(FormatError);
  });

  test("migrate keeps finite numbers and fills missing ones", () => {
    const doc = migrate(body({ rotation: 30, opacity: 0.5 }));
    expect(doc.nodes[0]).toMatchObject({ rotation: 30, opacity: 0.5, z: 0 });
  });

  test("buildPageSvg writes a rotation that got past migrate as a number, not as markup", () => {
    const reg = createRegistries();
    reg.nodeTypes.register(fileNodeType);
    const d = createDocument("nature-double");
    const n = { ...fileNodeDefaults(d.pages[0], { file: "a.png", subpath: "", show: "image" }, []), x: 0, y: 0, width: 10, height: 10 } as Node;
    (n as unknown as Record<string, unknown>).rotation = '0)"/><script>alert(1)</script><g x="(';
    (n as unknown as Record<string, unknown>).opacity = '0.5"/><script>alert(2)</script><g x="';
    d.nodes.push(n);
    const { svg } = buildPageSvg(d, d.pages[0], reg, new Map([[n.id, { kind: "image", dataUri: "data:image/png;base64,QQ==", naturalWidth: 1, naturalHeight: 1 }]]));
    expect(svg).not.toContain("<script");
  });
});
