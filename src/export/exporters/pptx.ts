import { MM_TO_PX } from "../../constants";
import { unionRect, type Rect } from "../../model/geometry";
import { ancestorsOf, isGroup } from "../../model/groups";
import { nodeLabel } from "../../model/labels";
import { isTransparentPaper } from "../../model/paper";
import type { Document, Node, NodeId, Page } from "../../model/types";
import type { Exporter, ExportInput } from "../../registry/exporter";
import { isExported, type PptxContext, type PptxPart } from "../../registry/node-type";
import type { AssetMap } from "../asset-types";
import { EMU_PER_MM, EMU_PER_PX, hexColor, nvPrXml, xfrmXml } from "../pptx/drawingml";
import { pictureXml } from "../pptx/media";
import { buildPptx, MAX_SLIDE_EMU, MIN_SLIDE_EMU, slideMediaRId, type PptxMedia, type PptxSlideInput } from "../pptx/package";
import { markdownToPlainText } from "../markdown-text";
import { fitDpi } from "../raster-size";
import { renderClearPngOnCanvas, type RenderClearPng } from "../rasterise";
import { buildPageSvg, skippedTypeWarning, unreadableTypeWarning } from "../svg-builder";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MEDIA_TYPES = { png: "image/png", jpeg: "image/jpeg" } as const;

/** PowerPoint's slide sides, in mm: 1 to 56 inches. */
export const MIN_SLIDE_MM = 25.4;
export const MAX_SLIDE_MM = 1422.4;

/** How far past an item's box its picture reaches, in page px, so that a border or shadow drawn outside the box is kept. */
const RASTER_MARGIN_PX = 8;

/** What the exporter draws pictures with: the browser's canvas, or a fake in tests. */
export interface PptxBackend {
  renderClearPng: RenderClearPng;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The slide for a page of `width` × `height` mm: the page scaled uniformly (1 when it fits) so that its sides are
 * within PowerPoint's 25.4-1422.4 mm, as whole EMU. A page too long and thin for both limits at once is scaled to fit
 * the longer side, and its shorter side is widened to the least a slide may have.
 */
export function slideFit(width: number, height: number): { scale: number; cx: number; cy: number } {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  let scale = 1;
  if (long > MAX_SLIDE_MM) scale = MAX_SLIDE_MM / long;
  else if (short < MIN_SLIDE_MM) scale = Math.min(MIN_SLIDE_MM / short, MAX_SLIDE_MM / long);
  const side = (mm: number) => Math.min(MAX_SLIDE_EMU, Math.max(MIN_SLIDE_EMU, Math.round(mm * scale * EMU_PER_MM)));
  return { scale, cx: side(width), cy: side(height) };
}

/** A page's size as a file name gives it: `183×247 mm`. */
const sizeName = (page: Page) => `${page.width}×${page.height} mm`;

/** The box of `rect` turned `rotation` degrees about its centre. */
function turnedBounds(rect: Rect, rotation: number): Rect {
  if (rotation % 360 === 0) return rect;
  const rad = (rotation * Math.PI) / 180;
  const w = Math.abs(rect.width * Math.cos(rad)) + Math.abs(rect.height * Math.sin(rad));
  const h = Math.abs(rect.width * Math.sin(rad)) + Math.abs(rect.height * Math.cos(rad));
  return { x: rect.x + rect.width / 2 - w / 2, y: rect.y + rect.height / 2 - h / 2, width: w, height: h };
}

/** What goes in a slide's shape tree, before it is written: an item, or a group of them kept as a `p:grpSp`. */
type Tree = { kind: "item"; node: Node } | { kind: "group"; node: Node; children: Tree[] };

/**
 * The page's items as a tree, in z order: its nodes that draw (not groups), each inside the groups it is a member of
 * whose drawing members are next to each other in z order. A group whose members are not is left out of the tree (its
 * members are written loose, in z order) and named in `flattened`, so the slide stacks its items as the figure does.
 */
export function slideTree(doc: Document, page: Page, registries: ExportInput["registries"], flattened: Node[], unreadable?: ReadonlySet<NodeId>): Tree[] {
  // What no export draws (a card, an association, a connector with an end on a card) is left out, inside groups too.
  const nodes = doc.nodes.filter((n) => n.page === page.id && isExported(doc, registries, n, unreadable)).sort((a, b) => a.z - b.z);
  const container = (id: NodeId) => isGroup(doc, id, registries);
  const items = nodes.filter((n) => !container(n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chains = items.map((n) => ancestorsOf(doc, n.id).filter((id) => byId.has(id) && container(id)).reverse());

  // Each group's items, by their place in z order: kept when they are a run with nothing else between.
  const places = new Map<NodeId, number[]>();
  chains.forEach((chain, i) => chain.forEach((id) => places.set(id, [...(places.get(id) ?? []), i])));
  const kept = new Set<NodeId>();
  for (const group of nodes) {
    const at = places.get(group.id);
    if (!at) continue;
    if (at[at.length - 1] - at[0] + 1 === at.length) kept.add(group.id);
    else flattened.push(group);
  }

  const root: Tree[] = [];
  const open: { id: NodeId; children: Tree[] }[] = [];
  const close = () => {
    const done = open.pop()!;
    const parent = open.length > 0 ? open[open.length - 1].children : root;
    parent.push({ kind: "group", node: byId.get(done.id)!, children: done.children });
  };
  items.forEach((node, i) => {
    const chain = chains[i].filter((id) => kept.has(id));
    let same = 0;
    while (same < open.length && same < chain.length && open[same].id === chain[same]) same++;
    while (open.length > same) close();
    for (const id of chain.slice(same)) open.push({ id, children: [] });
    (open.length > 0 ? open[open.length - 1].children : root).push({ kind: "item", node });
  });
  while (open.length > 0) close();
  return root;
}

/** The warnings building the pages' SVG gave, which say what the SVG did (rasterised, skipped), not what the slides do. */
function svgWarnings(input: ExportInput): Set<string> {
  const said = new Set<string>();
  for (const page of input.pages) {
    try {
      for (const w of buildPageSvg(input.doc, page, input.registries, input.assets.get(page.id) ?? new Map(), { unreadable: input.unreadable }).warnings) said.add(w);
    } catch {
      // A page whose SVG cannot be built again has no warnings to take out.
    }
  }
  return said;
}

/**
 * The PowerPoint exporter: one editable `.pptx` per page size (the size of the figure's first page `<base>.pptx`, each
 * other `<base> (<w>×<h> mm).pptx`, whichever pages are exported), one slide per page, in the order asked for. Each node is written by its type's `toPptx`;
 * a type without it, or one that answers `"raster"`, is written as a picture of its drawing at the export dpi, with a
 * warning. Groups whose members are next to each other in z order are `p:grpSp`; others are written loose, with a
 * warning. A page outside PowerPoint's slide sizes is scaled to fit, with a warning. Panels are trimmed (`pdfPanels`
 * raster: a PDF panel is its page's raster). The same warning is reported once. With the `notes` option, each slide's
 * presenter notes hold the plain text of the cards tied to its page (`ExportInput.cardMarkdown`). `now` dates the files.
 */
export function createPptxExporter(backend: PptxBackend = { renderClearPng: renderClearPngOnCanvas }, now: () => Date = () => new Date()): Exporter {
  return {
    id: "pptx",
    name: "PowerPoint (editable)",
    ext: "pptx",
    mime: PPTX_MIME,
    pdfPanels: "raster",
    options: () => [{ kind: "toggle", key: "notes", label: "Card text in presenter notes", placement: "end" }],
    async run(input: ExportInput, opts: Record<string, unknown>) {
      const warnings = new Set<string>();
      const fromSvg = svgWarnings(input);
      for (const w of input.warnings) if (!fromSvg.has(w)) warnings.add(w);
      const warn = (m: string) => {
        warnings.add(m);
      };
      let mediaCount = 0;

      /** `fragment` (page px) drawn over `box` on a clear background, as PNG bytes at the export dpi or the most that fits. */
      const rasterise = async (fragment: string, box: Rect, say: (message: string) => void): Promise<Uint8Array> => {
        if (!(box.width > 0 && box.height > 0)) throw new Error("it has no area to draw");
        const fit = fitDpi({ width: box.width / MM_TO_PX, height: box.height / MM_TO_PX }, input.dpi);
        if (fit.reduced) say(`drawn at ${fit.dpi} dpi (the largest that fits)`);
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fit.widthPx}" height="${fit.heightPx}" ` +
          `viewBox="${box.x} ${box.y} ${box.width} ${box.height}" preserveAspectRatio="none">${fragment}</svg>`;
        return backend.renderClearPng(svg, fit.widthPx, fit.heightPx);
      };

      const writeSlide = async (page: Page): Promise<PptxSlideInput> => {
        const fit = slideFit(page.width, page.height);
        if (fit.scale !== 1) {
          warn(`"${page.name}" is ${sizeName(page)}, outside PowerPoint's slide sizes (${MIN_SLIDE_MM}-${MAX_SLIDE_MM} mm a side): scaled to ${Math.round(fit.scale * 1000) / 10}%`);
        }
        const media: PptxMedia[] = [];
        const assets: AssetMap = input.assets.get(page.id) ?? new Map();
        let id = 1;
        const ctx: PptxContext = {
          registries: input.registries,
          doc: input.doc,
          page,
          assets,
          scale: fit.scale,
          px: (value) => Math.round(value * EMU_PER_PX * fit.scale),
          dpi: input.dpi,
          addMedia: (bytes, ext) => {
            media.push({ name: `image${++mediaCount}.${ext}`, bytes, contentType: MEDIA_TYPES[ext] });
            return slideMediaRId(media.length - 1);
          },
          nextId: () => ++id,
          rasterise: (fragment, box, say) => rasterise(fragment, box, say ?? ((m) => warn(`"${page.name}": ${m}`))),
          warn,
          unreadable: input.unreadable,
        };

        /** A node drawn as the SVG export draws it (turned and faded), as a picture of the box it reaches. */
        const asPicture = async (node: Node): Promise<string | null> => {
          const label = nodeLabel(input.doc, node);
          let box: Rect;
          let inner: string;
          try {
            const built = buildPageSvg(input.doc, page, input.registries, assets, { only: new Set([node.id]), paper: false, unreadable: input.unreadable });
            // What the SVG build said (rasterised, skipped) is not said by `svgWarnings`, as it is not about the slide.
            for (const w of built.warnings) warn(w);
            if (built.drawn === 0) {
              warn(`${label}: nothing to draw, skipped`);
              return null;
            }
            const type = input.registries.nodeTypes.get(node.type)!;
            const b = turnedBounds(type.bounds(node), node.rotation);
            box = { x: b.x - RASTER_MARGIN_PX, y: b.y - RASTER_MARGIN_PX, width: b.width + 2 * RASTER_MARGIN_PX, height: b.height + 2 * RASTER_MARGIN_PX };
            inner = built.svg.replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "");
          } catch (error) {
            warn(`${label}: could not be drawn as a picture (${message(error)}), skipped`);
            return null;
          }
          let png: Uint8Array;
          try {
            png = await rasterise(inner, box, (m) => warn(`${label}: ${m}`));
          } catch (error) {
            warn(`${label}: could not be drawn as a picture (${message(error)}), skipped`);
            return null;
          }
          warn(`${label}: written as a picture`);
          const rId = ctx.addMedia(png, "png");
          return pictureXml({ id: ctx.nextId(), name: node.name ?? node.id, rId, rect: box, pivot: { x: 0, y: 0 }, rotation: 0, alpha: 1 }, ctx);
        };

        const writeItem = async (node: Node): Promise<string> => {
          // An item its plugin could not read is never handed to its type: skipped, as one no plugin draws is.
          if (input.unreadable?.has(node.id)) {
            warn(unreadableTypeWarning(node.type));
            return "";
          }
          const type = input.registries.nodeTypes.get(node.type);
          if (!type) {
            warn(skippedTypeWarning(node.type));
            return "";
          }
          let part: PptxPart | "raster" | null | undefined;
          try {
            part = type.toPptx ? await type.toPptx(node, ctx) : "raster";
          } catch (error) {
            warn(`${nodeLabel(input.doc, node)}: could not be written as shapes (${message(error)})`);
            part = "raster";
          }
          if (part === "raster") return (await asPicture(node)) ?? "";
          return part?.xml ?? "";
        };

        /** An item's frame as drawn: its box turned by its rotation, axis-aligned. */
        const frameOf = (node: Node): Rect => {
          const type = input.registries.nodeTypes.get(node.type);
          return turnedBounds(type ? type.bounds(node) : node, node.rotation);
        };

        /**
         * The tree's XML, and the union of the frames of what it wrote (`null` when nothing). A group's frame is that
         * union, not its stored box: the stored box takes in members no export draws (a card beside the paper).
         */
        const write = async (tree: Tree[]): Promise<{ xml: string; frame: Rect | null }> => {
          const out: string[] = [];
          const frames: Rect[] = [];
          for (const t of tree) {
            if (t.kind === "item") {
              const xml = await writeItem(t.node);
              out.push(xml);
              if (xml !== "") frames.push(frameOf(t.node));
              continue;
            }
            const inside = await write(t.children);
            if (inside.xml === "" || !inside.frame) continue;
            const g = t.node;
            const f = inside.frame;
            frames.push(f);
            const off = { x: ctx.px(f.x), y: ctx.px(f.y) };
            // At least 1 EMU: a zero extent (and chExt) makes the group, and its members' scaling, undefined.
            const ext = { cx: Math.max(1, ctx.px(f.width)), cy: Math.max(1, ctx.px(f.height)) };
            // Child offset and extent equal to the group's own: its members' coordinates are the slide's.
            const xfrm = xfrmXml({ x: off.x, y: off.y, cx: ext.cx, cy: ext.cy }, 0).replace(
              "</a:xfrm>",
              `<a:chOff x="${off.x}" y="${off.y}"/><a:chExt cx="${ext.cx}" cy="${ext.cy}"/></a:xfrm>`,
            );
            const nv = `<p:nvGrpSpPr>${nvPrXml(ctx.nextId(), g.name ?? g.id)}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`;
            out.push(`<p:grpSp>${nv}<p:grpSpPr>${xfrm}</p:grpSpPr>${inside.xml}</p:grpSp>`);
          }
          return { xml: out.join(""), frame: frames.length > 0 ? unionRect(frames) : null };
        };

        const flattened: Node[] = [];
        const tree = slideTree(input.doc, page, input.registries, flattened, input.unreadable);
        for (const group of flattened) {
          warn(`${nodeLabel(input.doc, group)}: its members are not next to each other in the stacking order, written as separate items`);
        }
        const { xml } = await write(tree);
        let background: string | undefined;
        if (!isTransparentPaper(page.paper)) {
          const rgb = hexColor(page.paper);
          if (rgb) background = `#${rgb}`;
          else warn(`"${page.name}": the paper colour ${JSON.stringify(page.paper)} is not one PowerPoint can take, left white`);
        }
        return { xml, background, media, notes: await notesOf(page) };
      };

      /** With the `notes` option, the plain text of the cards tied to the page, in their order, a paragraph apart. */
      const notesOf = async (page: Page): Promise<string | undefined> => {
        if (opts.notes !== true || !input.cardMarkdown) return undefined;
        const texts = (await input.cardMarkdown(page.id)).map(markdownToPlainText).filter((text) => text !== "");
        return texts.length > 0 ? texts.join("\n\n") : undefined;
      };

      // One file per page size, in the order the sizes first come.
      const sizeKey = (page: Page) => `${page.width}x${page.height}`;
      const bySize = new Map<string, Page[]>();
      for (const page of input.pages) {
        const key = sizeKey(page);
        bySize.set(key, [...(bySize.get(key) ?? []), page]);
      }
      // The plain name is for the first size among the figure's pages (not the exported ones), so a size always
      // maps to the same file name, whichever pages are exported.
      const first = input.doc.pages[0] ?? input.pages[0];
      const plainSize = first ? sizeKey(first) : undefined;
      const files: { name: string; blob: Blob }[] = [];
      for (const pages of bySize.values()) {
        const slides: PptxSlideInput[] = [];
        for (const page of pages) slides.push(await writeSlide(page));
        const fit = slideFit(pages[0].width, pages[0].height);
        const bytes = buildPptx({ sizeEmu: { cx: fit.cx, cy: fit.cy }, slides, title: input.baseName, created: now() });
        const key = sizeKey(pages[0]);
        const name = key === plainSize ? `${input.baseName}.pptx` : `${input.baseName} (${sizeName(pages[0])}).pptx`;
        files.push({ name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: PPTX_MIME }) });
      }
      return { files, warnings: [...warnings] };
    },
  };
}

export const pptxExporter = createPptxExporter();
