// @vitest-environment happy-dom
// Security (F2): a PDF export fetches nothing outside the document, not even through an SVG nested in a data URI.
import "svg2pdf.js/dist/svg2pdf.es.js";
import { pdfExporter } from "../../src/export/exporters/pdf";
import { inlineSvg } from "../../src/export/inline-svg";
import { buildPageSvg } from "../../src/export/svg-builder";
import { createDocument, fileNodeDefaults } from "../../src/model/defaults";
import type { FileNode } from "../../src/model/types";
import { fileNodeSvg } from "../../src/nodes/file-node-svg";
import { createRegistries } from "../../src/registry";

vi.mock("svg2pdf.js", () => ({}));

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const nested = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="http://192.0.2.1/cgi-bin/reboot?x"/><image width="10" height="10" href="https://attacker.invalid/t.png"/></svg>`;
const plot =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  `<image width="10" height="10" href="data:image/svg+xml;base64,${btoa(nested)}"/>` +
  `<image x="20" width="10" height="10" href="data:image/png;base64,${PNG_1PX}"/></svg>`;

async function exportPlot(text: string) {
  const doc = createDocument("nature-double");
  const page = doc.pages[0];
  const panel: FileNode = { ...fileNodeDefaults(page, { file: "plot.svg", subpath: "", show: "image", frame: null }, []), id: "f", x: 20, y: 20, width: 100, height: 100 };
  doc.nodes.push(panel);
  const r = createRegistries();
  const asset = { kind: "svg" as const, text, width: 100, height: 100 };
  r.nodeTypes.register({ type: "file", toSvg: (n: FileNode, ctx: never) => fileNodeSvg(n, asset, ctx) } as never);
  const assets = new Map([["f", asset]]);
  const built = buildPageSvg(doc, page, r, assets);
  const result = await pdfExporter.run(
    { doc, pages: [page], svgs: new Map([[page.id, built.svg]]), assets: new Map([[page.id, assets]]), registries: r, warnings: built.warnings, baseName: "figure", dpi: 300 },
    {},
  );
  return { result, svg: built.svg };
}

afterEach(() => vi.restoreAllMocks());

/**
 * The URLs svg2pdf.js opens. Only data URIs go through; any other request is refused before it is sent, so that the
 * test can never reach a network (the addresses above are reserved ones besides: TEST-NET-1 and `.invalid`).
 */
function recordRequests(): string[] {
  const opened: string[] = [];
  const open = XMLHttpRequest.prototype.open;
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    opened.push(String(url));
    if (!String(url).startsWith("data:")) throw new Error(`test refused a request to ${String(url)}`);
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  });
  return opened;
}

test("an SVG data URI holding outside images makes the PDF export request nothing outside the document", async () => {
  const opened = recordRequests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { result } = await exportPlot(plot);
  expect(opened).toEqual([]);
  expect(result.warnings).toContain("an SVG image embedded as a data URI was left out of the PDF");
});

test("a raster data URI is still drawn in the PDF", async () => {
  recordRequests();
  const { result } = await exportPlot(plot);
  const text = new TextDecoder("latin1").decode(await result.files[0].blob.arrayBuffer());
  expect(text).toMatch(/\/Subtype\s*\/Image/);
});

test("the pattern svg2pdf.js is given loads raster data URIs only", async () => {
  const { pdfLoadableImage } = await import("../../src/export/exporters/pdf");
  for (const ok of ["data:image/png;base64,QQ==", " data:image/JPEG;base64,QQ==", "data:image/webp,x"]) expect(pdfLoadableImage.test(ok)).toBe(true);
  for (const no of ["data:image/svg+xml;base64,QQ==", "http://192.0.2.1/x.png", "file:///etc/passwd", "data:text/html,x", "x.png"]) expect(pdfLoadableImage.test(no)).toBe(false);
});

describe("data URIs an inlined SVG keeps", () => {
  test.each(["png", "jpeg", "gif", "webp", "bmp", "avif", "svg+xml"])("image/%s stays", (type) => {
    expect(inlineSvg(`<svg><image href="data:image/${type};base64,QQ=="/></svg>`, "p-")).toBe(`<image href="data:image/${type};base64,QQ=="/>`);
  });

  test.each(["data:text/html,<script>alert(1)</script>", "data:application/xhtml+xml;base64,QQ==", " DATA:text/javascript,alert(1)", "data:,x"])(
    "%s is dropped with a warning",
    (uri) => {
      const warnings: string[] = [];
      expect(inlineSvg(`<svg><a href="${uri.replace(/</g, "&lt;")}"><rect/></a></svg>`, "p-", warnings)).toBe("<a><rect/></a>");
      expect(warnings[0]).toMatch(/^external reference removed: /);
    },
  );
});
