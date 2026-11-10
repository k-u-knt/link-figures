import { Component, MarkdownRenderer, setIcon } from "obsidian";
import type { FileAsset, SkippedAsset } from "../export/asset-types";
import { joinLinktext } from "../format/links-section";
import type { Resolved } from "../links/types";
import { boxAttachable } from "../model/attach";
import { defaultBorder } from "../model/defaults";
import { cropInset, cropPlacement, cropWithInset, visibleCrop, type CropSide, type Rect } from "../model/geometry";
import { isLocked } from "../model/groups";
import { nodeLabel } from "../model/labels";
import type { FileNode } from "../model/types";
import type { Field } from "../registry/fields";
import type { FieldRoute, ImageState, InspectorContext, NodeRenderer, NodeType, RenderContext, SvgContext } from "../registry/node-type";
import { strokeFields } from "../registry/paint";
import { fieldError, paramError, type ParamSpec } from "../registry/params";
import { displayFields, displayRoute } from "./display-fields";
import { fileNodePptx } from "./file-node-pptx";
import { fileFrameSvg, fileNodeSvg, skippedReason } from "./file-node-svg";

export { fileFrameSvg, fileNodeSvg, skippedReason };

const SVG_NS = "http://www.w3.org/2000/svg";

/** Stage renderers made so far: each one's ids start with its own number, so two frames' gradients never share an id. */
let renderers = 0;

type Size = { width: number; height: number };
/** A caller of `naturalSize()` waiting for the image to load. */
interface Waiter {
  resolve(size: Size): void;
  reject(error: Error): void;
}
type Missing = Extract<Resolved, { kind: "missing" }>;

const REASON_TEXT: Record<Missing["reason"], string> = {
  file: "File not found",
  subpath: "Subpath not found (heading or block)",
  "no-image": "No image in that section",
  decode: "The file could not be decoded",
};

/** What a browser uses for an image that reports no size of its own (an SVG without width, height or viewBox). */
const FALLBACK_NATURAL: Size = { width: 300, height: 150 };

/** Link targets that have more than one page. */
const PAGED_EXTENSIONS = new Set(["pdf", "tif", "tiff"]);

function extensionOf(path: string): string {
  return /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase() ?? "";
}

type BodyKind = "pending" | "image" | "content" | "missing";

/**
 * One file node's DOM: `.lf-node` holding the body (the image, the rendered note section, or a placeholder), the frame
 * (an inline `<svg>` of the fragment the export draws, `fileFrameSvg`, over the body) and the badge that opens the link.
 * What the body shows comes from `ctx.resolved(id)`; `update` re-reads it.
 * Also answers `naturalSize()` (see `NodeHost.naturalSize`).
 */
class FileNodeRenderer implements NodeRenderer {
  private node: FileNode;
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly idPrefix = `lf-file-${++renderers}`;
  /** The markup the frame was last drawn from (empty for no frame), so an update that does not change it leaves it be. */
  private frameMarkup = "";
  /** What drawing the frame last warned about, so it is logged once, and again only when it changes. */
  private warned = "";

  /** The `Resolved` the body was built from; `null` before the first build, `undefined` while the node is unresolved. */
  private renderedResolved: Resolved | undefined | null = null;
  private bodyKind: BodyKind = "pending";
  private imageEl: HTMLImageElement | null = null;
  /** The `.lf-image` element round the picture: it is placed at the crop's region, and clips the picture to it. */
  private imageFrame: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  /** Owns the components the markdown renderer creates, so a re-render or unmount can release them. */
  private card: Component | null = null;
  /** Why the image could not be shown although it resolved; shown on the badge. */
  private loadFailure: string | null = null;

  /** The loaded image's own size; null until it has loaded, and while the body shows no image. */
  private natural: Size | null = null;
  private waiters: Waiter[] = [];
  /** Callers of `drawn()` waiting for the image to load or fail. */
  private drawWaiters: (() => void)[] = [];
  /** The rendering of the note content the body shows; settled when there is none. */
  private contentDrawn: Promise<void> = Promise.resolve();

  constructor(node: FileNode, host: HTMLElement, private readonly ctx: RenderContext) {
    this.node = node;
    this.el = host.createDiv({ cls: "lf-node" });
    this.body = this.el.createDiv({ cls: "lf-node-body" });
    this.frameEl = this.el.createDiv({ cls: "lf-frame" });
    this.badge = this.el.createDiv({ cls: "lf-badge" });
    setIcon(this.badge, "link");
    this.badge.addEventListener("click", (evt) => this.ctx.openLink(joinLinktext(this.node.file, this.node.subpath), evt));
    this.update(node);
  }

  update(node: FileNode): void {
    this.node = node;
    this.applyBox();
    this.drawFrame();
    const resolved = this.ctx.resolved(node.id);
    if (resolved !== this.renderedResolved) this.renderBody(resolved);
    else this.refreshBody();
    this.refreshBadge(resolved);
  }

  unmount(): void {
    this.clearBody("The node was removed");
    this.el.remove();
  }

  /** Resolves once the body has finished drawing: its image loaded or failed, its note content rendered or failed to. */
  drawn(): Promise<void> {
    if (this.bodyKind === "content") return this.contentDrawn;
    if (this.bodyKind === "image" && !this.natural) return new Promise((resolve) => this.drawWaiters.push(resolve));
    return Promise.resolve();
  }

  /** The size of the image shown: now if it has loaded, else once it has; rejects when the node shows no image. */
  naturalSize(): Promise<Size> {
    if (this.natural) return Promise.resolve(this.measured(this.natural));
    if (this.bodyKind === "content" || this.bodyKind === "missing") return Promise.reject(new Error("The node shows no image"));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** The size of the image shown if it has loaded with one; null while it has not (and for an image without a size). */
  naturalSizeNow(): Size | null {
    const n = this.natural;
    return n && n.width > 0 && n.height > 0 ? { ...n } : null;
  }

  /** Whether an image shows: `image` once loaded, `loading` until then, `none` for a badge, a failed image or note content. */
  imageStateNow(): ImageState {
    if (this.bodyKind === "content" || this.bodyKind === "missing") return "none";
    return this.bodyKind === "image" && this.naturalSizeNow() ? "image" : "loading";
  }

  /** The URL the shown image was loaded from, once it has loaded; null otherwise. */
  imageSourceNow(): string | null {
    const img = this.imageEl;
    return img && this.natural ? img.currentSrc || img.src || null : null;
  }

  private applyBox(): void {
    const n = this.node;
    const style = this.el.style;
    style.left = `${n.x}px`;
    style.top = `${n.y}px`;
    style.width = `${n.width}px`;
    style.height = `${n.height}px`;
    style.zIndex = String(n.z);
    style.transform = n.rotation === 0 ? "" : `rotate(${n.rotation}deg)`;
    style.opacity = n.opacity === 1 ? "" : String(n.opacity);
  }

  /** The frame drawn over the node's box, or nothing when the node has none. */
  private drawFrame(): void {
    const n = this.node;
    const defs: string[] = [];
    const warnings: string[] = [];
    const counters = new Map<string, number>();
    const uid = (prefix: string): string => {
      const count = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, count);
      return `${this.idPrefix}-${prefix}-${count}`;
    };
    const fragment = fileFrameSvg(n, { registries: this.ctx.registries, defs, warnings, uid });
    const said = warnings.join("\n");
    if (said !== "" && said !== this.warned) console.warn(`Link Figures: frame of ${n.id}: ${warnings.join("; ")}`);
    this.warned = said;
    const markup =
      fragment === ""
        ? ""
        : `<svg xmlns="${SVG_NS}" viewBox="${n.x} ${n.y} ${n.width} ${n.height}" preserveAspectRatio="none">` +
          `${defs.length > 0 ? `<defs>${defs.join("")}</defs>` : ""}${fragment}</svg>`;
    if (markup === this.frameMarkup) return;
    this.frameMarkup = markup;
    if (markup === "") {
      this.frameEl.replaceChildren();
      return;
    }
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
    if (parsed.getElementsByTagName("parsererror").length > 0) {
      console.error(`Link Figures: could not draw the frame of ${n.id}`);
      this.frameEl.replaceChildren();
      return;
    }
    this.frameEl.replaceChildren(this.el.ownerDocument.importNode(parsed.documentElement, true));
  }

  private renderBody(resolved: Resolved | undefined): void {
    this.renderedResolved = resolved;
    this.loadFailure = null;
    if (!resolved) {
      this.clearBody("The node is not resolved yet", false);
    } else if (resolved.kind === "image") {
      this.showImage(resolved.src);
    } else if (resolved.kind === "content") {
      this.showContent(resolved);
    } else {
      this.showPlaceholder(REASON_TEXT[resolved.reason]);
    }
  }

  /** The body already shows what was resolved; only the node's own box, crop, fit or scale may have changed. */
  private refreshBody(): void {
    if (this.bodyKind === "image") this.placeImage();
    else if (this.bodyKind === "content") this.scaleContent();
  }

  private refreshBadge(resolved: Resolved | undefined): void {
    const linktext = joinLinktext(this.node.file, this.node.subpath);
    const problem = resolved?.kind === "missing" ? REASON_TEXT[resolved.reason] : this.loadFailure;
    this.badge.classList.toggle("is-missing", problem !== null);
    this.badge.title = problem === null ? linktext : `${linktext}: ${problem}`;
  }

  /** Empties the body and releases what it held. Callers waiting on `naturalSize()` are rejected unless the node may yet get an image. */
  private clearBody(reason: string, failWaiters = true): void {
    if (this.card) {
      this.ctx.component.removeChild(this.card);
      this.card = null;
    }
    this.body.empty();
    this.imageEl = null;
    this.imageFrame = null;
    this.contentEl = null;
    this.natural = null;
    this.bodyKind = "pending";
    this.contentDrawn = Promise.resolve();
    this.releaseDrawWaiters();
    if (failWaiters) this.settle((w) => w.reject(new Error(reason)));
  }

  private releaseDrawWaiters(): void {
    const waiters = this.drawWaiters;
    this.drawWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private showImage(src: string): void {
    if (this.bodyKind !== "image" || !this.imageEl) {
      this.clearBody("The node was replaced", false);
      const frame = this.body.createDiv({ cls: "lf-image" });
      const img = frame.createEl("img");
      img.draggable = false;
      img.addEventListener("load", () => this.onImageLoad(img));
      img.addEventListener("error", () => this.onImageError(img));
      this.imageEl = img;
      this.imageFrame = frame;
      this.bodyKind = "image";
    }
    // A new `src` keeps the old size until it has loaded, so a refreshed image does not jump.
    if (this.imageEl.getAttribute("src") !== src) this.imageEl.src = src;
    this.placeImage();
  }

  private onImageLoad(img: HTMLImageElement): void {
    if (img !== this.imageEl) return;
    this.natural = { width: img.naturalWidth, height: img.naturalHeight };
    this.placeImage();
    const size = this.measured(this.natural);
    this.settle((w) => w.resolve(size));
    this.releaseDrawWaiters();
  }

  private onImageError(img: HTMLImageElement): void {
    if (img !== this.imageEl) return;
    this.showPlaceholder("The image could not be loaded");
    this.loadFailure = "The image could not be loaded";
    this.refreshBadge(this.renderedResolved ?? undefined);
  }

  /** The image's size, or a default for an image that has none (so a caller never divides by zero). */
  private measured(size: Size): Size {
    return size.width > 0 && size.height > 0 ? size : FALLBACK_NATURAL;
  }

  /**
   * Shows the crop region at the node's fit: the frame is put at the part of the box the region fills (all of it with
   * `cover`, a letterboxed rectangle with `contain`) and clips the whole image, placed inside it. `object-fit` cannot crop.
   */
  private placeImage(): void {
    const img = this.imageEl;
    const frame = this.imageFrame;
    if (!img || !frame) return;
    const box = { width: this.node.width, height: this.node.height };
    const { image, region } = cropPlacement(box, this.natural ?? { width: 0, height: 0 }, this.node.crop, this.node.fit);
    frame.style.left = `${region.x}px`;
    frame.style.top = `${region.y}px`;
    frame.style.width = `${region.width}px`;
    frame.style.height = `${region.height}px`;
    img.style.left = `${image.x - region.x}px`;
    img.style.top = `${image.y - region.y}px`;
    img.style.width = `${image.width}px`;
    img.style.height = `${image.height}px`;
  }

  private showContent(resolved: Extract<Resolved, { kind: "content" }>): void {
    this.clearBody("The node shows note content, not an image");
    this.bodyKind = "content";
    const holder = this.body.createDiv({ cls: ["lf-content", "markdown-rendered"] });
    this.contentEl = holder;
    this.scaleContent();
    // The source note's path, so relative links and embeds inside the section resolve as they do in the note.
    const card = new Component();
    this.ctx.component.addChild(card);
    this.card = card;
    this.contentDrawn = MarkdownRenderer.render(this.ctx.app, resolved.markdown, holder, resolved.file.path, card).catch((error: unknown) => {
      console.error(`Link Figures: could not render the content of node ${this.node.id}`, error);
    });
  }

  private scaleContent(): void {
    if (this.contentEl) this.contentEl.style.fontSize = `calc(var(--font-text-size) * ${this.node.scale})`;
  }

  private showPlaceholder(text: string): void {
    this.clearBody("The node shows no image");
    this.bodyKind = "missing";
    this.body.createDiv({ cls: "lf-placeholder", text });
  }

  private settle(apply: (waiter: Waiter) => void): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) apply(waiter);
  }
}

/** What `node.update` checks of a file node's own fields. Its link (`file`, `subpath`) lives in the Links section. */
const FILE_FIELDS: ParamSpec = {
  file: { type: "string" },
  subpath: { type: "string" },
  show: { type: "string", enum: ["image", "content"] },
  imageIndex: { type: "integer", minimum: 0 },
  crop: {
    type: "object",
    nullable: true,
    properties: {
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      w: { type: "number", required: true },
      h: { type: "number", required: true },
    },
  },
  fit: { type: "string", enum: ["cover", "contain"] },
  pageIndex: { type: "integer", minimum: 0 },
  scale: { type: "number", exclusiveMinimum: 0 },
  frame: { type: "stroke", nullable: true },
  // As the file format reads them: a missing `enabled` is true and missing `params` none.
  adjustments: {
    type: "array",
    items: { type: "object", properties: { type: { type: "string", required: true }, enabled: { type: "boolean" }, params: { type: "object" } } },
  },
};

/** `range`: a 16-bit image's display range, `{ min, max }` (finite numbers), or `"auto"`. */
const RANGE: ParamSpec = { min: { type: "number", required: true }, max: { type: "number", required: true } };

/** What `node.update` checks of a file node's field `key`: `range` by `RANGE`, the rest by `FILE_FIELDS`. */
function fileFieldError(key: string, value: unknown, ctx?: { patch?: Record<string, unknown> }): string | null {
  if (key !== "range" || value === "auto") return fieldError(FILE_FIELDS, key, value, ctx);
  return paramError(key, { type: "object", properties: RANGE }, value) === null ? null : '"range" must be "auto" or { min, max } (finite numbers)';
}

/** The crop's inset fields, by key: each is how far in (in %) that side of the image the crop starts. */
const CROP_SIDES: Record<string, CropSide> = { "crop.left": "left", "crop.top": "top", "crop.right": "right", "crop.bottom": "bottom" };

/** An inspector field for the inset of one side of the crop, 0–100 %. */
const cropField = (key: string): Field => {
  const side = CROP_SIDES[key];
  return { kind: "number", key, label: `Crop ${side} (%)`, min: 0, max: 100, step: 1 };
};

/** Whether the view shows `node` without an image (only its badge, say): it has no crop to edit. Headless it is not known, so false. */
function showsNoImage(node: FileNode, ctx?: InspectorContext): boolean {
  return ctx?.imageStateNow?.(node.id) === "none";
}

/**
 * The crop `node` shows now: its own, or, once the view knows the image's size, what is visible of it (`visibleCrop`),
 * which differs when the fit hides part of the crop (cover with another aspect than the box's).
 */
function shownCrop(node: FileNode, ctx?: InspectorContext): FileNode["crop"] {
  const natural = ctx?.imageSizeNow?.(node.id);
  return natural ? visibleCrop(node, natural) : node.crop;
}

/**
 * A crop inset field reads the inset of the crop that shows and is written by `panel.crop` with keep "image": the image
 * stays where it is and the box follows the side that changed. A write starts from what is visible, as crop mode's first
 * edit does, so the box does not take in a strip the fit had hidden.
 */
function cropRoute(key: string): FieldRoute<FileNode> | undefined {
  const side = CROP_SIDES[key];
  if (!side) return undefined;
  return {
    read: (node, ctx) => cropInset(shownCrop(node, ctx), side) * 100,
    applies: (node, doc, ctx) => node.show === "image" && !isLocked(doc, node.id) && !showsNoImage(node, ctx),
    call: (node, value, ctx) => ({
      id: "panel.crop",
      args: { id: node.id, crop: cropWithInset(shownCrop(node, ctx), side, Number(value) / 100), keep: "image" },
    }),
  };
}

/** A note section or image linked from the vault, drawn live from its source. */
export const fileNodeType: NodeType<FileNode> = {
  type: "file",
  name: "Linked file",
  icon: "image",
  // Every panel has a link (an empty one when it has none), kept in the figure file's Links section.
  linkField: { always: true },

  mount(node: FileNode, host: HTMLElement, ctx: RenderContext): NodeRenderer {
    return new FileNodeRenderer(node, host, ctx);
  },

  bounds(node: FileNode): Rect {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  },

  /**
   * The page of a paged file, the crop insets of an image, its Display section (a TIFF or raster picture), then a Frame toggle (off is `frame: null`, on is the default border) and, while there is a
   * frame, its paint, width and dashes.
   */
  inspector(node: FileNode, ctx: InspectorContext): Field[] {
    const page: Field[] = PAGED_EXTENSIONS.has(extensionOf(node.file)) ? [{ kind: "number", key: "pageIndex", label: "Page", min: 0, step: 1 }] : [];
    return [
      ...page,
      // An image panel's crop, as the inset of each side; a panel that shows note content, or that the view shows only
      // a badge for (its link does not resolve), has nothing to crop.
      ...(node.show === "image" && !showsNoImage(node, ctx) ? Object.keys(CROP_SIDES).map(cropField) : []),
      ...displayFields(node, ctx),
      { kind: "toggle", key: "frame", label: "Frame", onValue: defaultBorder() },
      ...(node.frame ? strokeFields("frame", "Frame") : []),
    ];
  },

  /** Its box, rotated: anchors `n e s w`. */
  attachable: boxAttachable,

  fieldRoute: (key) => cropRoute(key) ?? displayRoute(key),

  /** An adjustment without `enabled` is on, and one without `params` has none, as a file's are read. */
  completeUpdate(_before: FileNode, after: FileNode): FileNode {
    const adjustments: unknown = after.adjustments;
    if (!Array.isArray(adjustments)) return after;
    const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const filled = adjustments.map((a) =>
      isRecord(a) ? { ...a, enabled: a.enabled === undefined ? true : a.enabled, params: a.params === undefined ? {} : a.params } : a,
    );
    return { ...after, adjustments: filled as FileNode["adjustments"] };
  },

  checkField: (key, value, ctx) => fileFieldError(key, value, ctx),

  toSvg(node: FileNode, ctx: SvgContext): string | "raster" {
    const asset = ctx.assets.get(node.id);
    // A rasterised content card is the exporter's business, not an asset of this node type.
    const fileAsset: FileAsset | SkippedAsset | undefined = asset && asset.kind !== "raster" ? asset : undefined;
    return fileNodeSvg(node, fileAsset, ctx);
  },

  /** The frame, over whatever draws the panel: its picture, a raster of its card, or its PDF page embedded as vectors. */
  overlaySvg(node: FileNode, ctx: SvgContext): string {
    const warnings: string[] = [];
    const fragment = fileFrameSvg(node, { registries: ctx.registries, defs: ctx.defs, warnings, uid: (prefix) => ctx.uid(prefix) });
    for (const warning of warnings) ctx.warnings.push(`${nodeLabel(ctx.doc, node)}: ${warning}`);
    return fragment;
  },

  toPptx: fileNodePptx,
};
