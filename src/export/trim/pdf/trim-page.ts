import {
  decodePDFRawStream,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFObject,
} from "@cantoo/pdf-lib";
import type { Rect } from "../../../model/geometry";
import { ContentParseError, tokenize } from "./tokenize";
import { findUnits, multiply, type Matrix, type ResourceInfo } from "./units";

/**
 * Trimming a PDF page for the vector PDF export (spec §3.5): every drawing of the page's content that lies wholly
 * outside the visible region is removed, inside form XObjects too, and the page is handed back as a one-page PDF whose
 * resources hold only what the trimmed content still names. A drawing that is not wholly outside, or whose place is not
 * known, is kept, and a page that cannot be trimmed with certainty is not trimmed at all (`TrimFallback`).
 */

/** The page cannot be trimmed safely; `message` says why. The panel is then embedded whole. */
export class TrimFallback extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TrimFallback";
  }
}

/** Forms are trimmed inside down to this depth (the page's own content is depth 0); deeper ones are kept whole. */
const MAX_DEPTH = 8;
const DEPTH_NOTE = `a nested drawing deeper than ${MAX_DEPTH} levels was kept whole`;

/** The resource categories pruned to what the content names; the others are copied as they are. */
const PRUNED = new Set(["Font", "XObject", "Shading", "Pattern"]);

/** The filters pdf-lib decodes (by their full names; it does not know the abbreviations). */
const DECODABLE = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);

/** Entries of a stream's dictionary that describe its stored bytes, which a rewritten stream sets afresh. */
const STORAGE_KEYS = new Set(["Length", "Filter", "DecodeParms", "DL", "F", "FFilter", "FDecodeParms"]);

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const RESOURCES = PDFName.of("Resources");
const XOBJECT = PDFName.of("XObject");

/** What one trim of a page shares across the streams it rewrites. */
interface TrimState {
  doc: PDFDocument;
  /** The visible region in the page's user space. */
  visible: Rect;
  pageResources: PDFDict | undefined;
  /** False when some drawing reads the page's resources from inside another stream: the page's are then kept whole. */
  prune: boolean;
  notes: Set<string>;
  /** Trimmed form copies made so far, for their names. */
  copies: number;
}

/**
 * The page at `pageIndex` of `bytes` with every drawing wholly outside `visible` removed, as a one-page PDF with the
 * page's MediaBox and CropBox. `visible` is in points from the top-left corner of the page's CropBox (as
 * `visibleSourceRect` gives it for a `PdfAsset`), so the result is placed exactly as the page was. `removed` counts the
 * drawings removed at every depth; `notes` are said in the export's report. Throws `TrimFallback` when the page cannot
 * be trimmed safely.
 */
export async function trimPdfPage(bytes: ArrayBuffer, pageIndex: number, visible: Rect): Promise<{ bytes: Uint8Array; removed: number; notes: string[] }> {
  try {
    return await trim(await load(bytes), pageIndex, visible);
  } catch (error) {
    if (error instanceof TrimFallback) throw error;
    if (error instanceof ContentParseError) throw new TrimFallback(`the page's content could not be read: ${error.message}`);
    throw new TrimFallback(error instanceof Error ? error.message : String(error));
  }
}

/** The PDF as pdf-lib reads it; a file with only an owner password opens with the empty user password (as the exporter does). */
async function load(bytes: ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (error) {
    if (!(error instanceof EncryptedPDFError)) throw error;
    return PDFDocument.load(bytes, { password: "" });
  }
}

async function trim(doc: PDFDocument, pageIndex: number, visible: Rect): Promise<{ bytes: Uint8Array; removed: number; notes: string[] }> {
  if (!(pageIndex >= 0 && pageIndex < doc.getPageCount())) throw new TrimFallback(`the PDF has no page ${pageIndex + 1}`);
  const page = doc.getPage(pageIndex);
  // The visible region is measured on the page as shown, which a rotation of its own would turn.
  if (page.getRotation().angle % 360 !== 0) throw new TrimFallback("the page has a rotation of its own");

  const media = page.getMediaBox();
  const crop = page.getCropBox();
  // The panel's size is that of the page as shown, the CropBox within the MediaBox; outside it the two would differ.
  if (crop.x < media.x || crop.y < media.y || crop.x + crop.width > media.x + media.width || crop.y + crop.height > media.y + media.height) {
    throw new TrimFallback("the page's CropBox reaches outside its MediaBox");
  }
  // From the CropBox's top-left corner, y down, to user space, y up: as `pdfPanelPlacement` and the exporter measure it.
  const target: Rect = { x: crop.x + visible.x, y: crop.y + crop.height - visible.y - visible.height, width: visible.width, height: visible.height };
  const pageResources = page.node.Resources();
  const state: TrimState = { doc, visible: target, pageResources, prune: !borrowsPageResources(pageResources), notes: new Set(), copies: 0 };
  const trimmed = trimStream(state, pageContent(page.node.lookup(PDFName.of("Contents"))), pageResources, IDENTITY, 0);

  const out = await PDFDocument.create();
  const outPage = out.addPage([media.width, media.height]);
  outPage.setMediaBox(media.x, media.y, media.width, media.height);
  outPage.setCropBox(crop.x, crop.y, crop.width, crop.height);
  // Only what the new resources reach is copied, so nothing the trimmed content no longer names rides along.
  outPage.node.set(RESOURCES, PDFObjectCopier.for(doc.context, out.context).copy(trimmed.resources));
  outPage.node.set(PDFName.of("Contents"), out.context.register(out.context.flateStream(trimmed.bytes)));
  return { bytes: await out.save(), removed: trimmed.removed, notes: [...state.notes] };
}

/** The page's content: one stream, or an array of them joined by newlines, decoded. A page without content is empty. */
function pageContent(contents: PDFObject | undefined): Uint8Array {
  if (contents === undefined) return new Uint8Array(0);
  if (!(contents instanceof PDFArray)) return decodeStream(contents);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < contents.size(); i++) parts.push(decodeStream(contents.lookup(i)));
  return join(parts, 0x0a);
}

/** A stream's decoded bytes. A filter pdf-lib cannot decode, or decoding parameters it would ignore, cannot be trimmed. */
function decodeStream(stream: PDFObject | undefined): Uint8Array {
  if (!(stream instanceof PDFRawStream)) throw new TrimFallback("a content stream is missing or of a kind that cannot be read");
  const filter = stream.dict.lookup(PDFName.of("Filter"));
  const filters = filter instanceof PDFArray ? Array.from({ length: filter.size() }, (_, i) => filter.lookup(i)) : filter ? [filter] : [];
  for (const f of filters) {
    const name = f instanceof PDFName ? f.decodeText() : String(f);
    if (!DECODABLE.has(name)) throw new TrimFallback(`a content stream is encoded with ${name}, which cannot be decoded`);
  }
  // pdf-lib does not undo a predictor, so a predicted stream would come out as garbage.
  const parms = stream.dict.lookup(PDFName.of("DecodeParms"));
  const parmList = parms instanceof PDFArray ? Array.from({ length: parms.size() }, (_, i) => parms.lookup(i)) : [parms];
  for (const p of parmList) {
    const predictor = p instanceof PDFDict ? p.lookup(PDFName.of("Predictor")) : undefined;
    if (predictor instanceof PDFNumber && predictor.asNumber() > 1) throw new TrimFallback("a content stream uses a predictor, which cannot be decoded");
  }
  try {
    return decodePDFRawStream(stream).decode();
  } catch (error) {
    throw new TrimFallback(`a content stream could not be decoded (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * One content stream, trimmed: the units wholly outside the visible region removed and a crossing form's `Do` pointed
 * at a trimmed copy of the form, everything else verbatim. Returns the new bytes, the resources they need (a new
 * dictionary in the source document), and how many units were removed here and in the forms below.
 */
function trimStream(
  state: TrimState,
  content: Uint8Array,
  resources: PDFDict | undefined,
  ctm: Matrix,
  depth: number,
): { bytes: Uint8Array; resources: PDFDict; removed: number } {
  const units = findUnits(tokenize(content), content, pdfResourceInfo(resources), ctm);
  const edits: { start: number; end: number; text: string }[] = [];
  const copies = new Map<string, PDFRef>();
  let removed = 0;
  for (const unit of units) {
    if (!unit.box) continue;
    if (isOutside(unit.box, state.visible)) {
      edits.push({ start: unit.start, end: unit.end, text: "" });
      removed++;
      continue;
    }
    if (unit.kind !== "xobject" || isInside(unit.box, state.visible)) continue;
    // A form crossing the edge: what lies outside inside it goes from a copy of it, drawn by this Do only.
    const form = formNamed(resources, unit.name!);
    if (!form) continue;
    if (depth >= MAX_DEPTH) {
      state.notes.add(DEPTH_NOTE);
      continue;
    }
    const matrix = numbersOf(form.dict.lookup(PDFName.of("Matrix")), 6) ?? IDENTITY;
    const inner = trimStream(
      state,
      decodeStream(form),
      form.dict.lookupMaybe(RESOURCES, PDFDict) ?? state.pageResources,
      multiply(matrix as Matrix, unit.ctm!),
      depth + 1,
    );
    if (inner.removed === 0) continue;
    removed += inner.removed;
    const name = copyName(state, unit.name!, resources, copies);
    copies.set(name, state.doc.context.register(formCopy(state, form, inner.bytes, inner.resources)));
    edits.push({ start: unit.start, end: unit.end, text: `${encodeName(name)} Do` });
  }
  const bytes = splice(content, edits);
  return { bytes, resources: prunedResources(state, resources, namesUsed(bytes), copies), removed };
}

/** Touching the region counts as inside. */
function isOutside(box: Rect, v: Rect): boolean {
  return box.x > v.x + v.width || box.x + box.width < v.x || box.y > v.y + v.height || box.y + box.height < v.y;
}

function isInside(box: Rect, v: Rect): boolean {
  return box.x >= v.x && box.x + box.width <= v.x + v.width && box.y >= v.y && box.y + box.height <= v.y + v.height;
}

/** The form XObject `name` names in `resources`, or undefined when it is not a form. */
function formNamed(resources: PDFDict | undefined, name: string): PDFRawStream | undefined {
  const xobject = entry(resources, "XObject", name);
  return xobject instanceof PDFRawStream && subtype(xobject.dict) === "Form" ? xobject : undefined;
}

/** A trimmed copy of `form`: its dictionary but for how its bytes are stored, the new content and resources. */
function formCopy(state: TrimState, form: PDFRawStream, content: Uint8Array, resources: PDFDict): PDFRawStream {
  const copy = state.doc.context.flateStream(content);
  for (const [key, value] of form.dict.entries()) if (!STORAGE_KEYS.has(key.decodeText())) copy.dict.set(key, value);
  copy.dict.set(RESOURCES, resources);
  return copy;
}

/** `<name>_lf<n>`, with the next n not already a name of the stream's XObjects. */
function copyName(state: TrimState, name: string, resources: PDFDict | undefined, copies: Map<string, PDFRef>): string {
  const taken = new Set(keysOf(resources?.lookupMaybe(XOBJECT, PDFDict)));
  let candidate: string;
  do candidate = `${name}_lf${++state.copies}`;
  while (taken.has(candidate) || copies.has(candidate));
  return candidate;
}

/**
 * New resources for a rewritten stream: the pruned categories keep only the names the stream uses (any name token
 * counts, whatever operator it is for, which errs on keeping), with the trimmed copies added to the XObjects; the other
 * categories are copied as they are. When pruning is off, every name is kept.
 */
function prunedResources(state: TrimState, resources: PDFDict | undefined, used: Set<string>, copies: Map<string, PDFRef>): PDFDict {
  const context = state.doc.context;
  const out = context.obj({});
  for (const [key, value] of resources?.entries() ?? []) {
    const category = key.decodeText();
    const names = resources!.lookup(key);
    if (!PRUNED.has(category) || !(names instanceof PDFDict)) {
      out.set(key, value);
      continue;
    }
    const kept = context.obj({});
    for (const [name, object] of names.entries()) if (!state.prune || used.has(name.decodeText())) kept.set(name, object);
    if (kept.keys().length) out.set(key, kept);
  }
  if (copies.size) {
    const xobjects = out.lookupMaybe(XOBJECT, PDFDict) ?? context.obj({});
    for (const [name, ref] of copies) xobjects.set(nameKey(name), ref);
    out.set(XOBJECT, xobjects);
  }
  return out;
}

/**
 * Whether a drawing reachable from the page's resources (a form, a Type 3 font, a tiling pattern) has no resources of
 * its own and so reads the page's (allowed by older PDFs). The names it uses are then not in the page's content, so the
 * page's resources must not be pruned.
 */
function borrowsPageResources(resources: PDFDict | undefined, seen = new Set<PDFDict>()): boolean {
  if (!resources || seen.has(resources)) return false;
  seen.add(resources);
  for (const category of ["XObject", "Font", "Pattern"]) {
    const names = resources.lookupMaybe(PDFName.of(category), PDFDict);
    for (const name of names?.keys() ?? []) {
      const object = names!.lookup(name);
      const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : undefined;
      if (!dict) continue;
      if (!drawsWithResources(category, dict)) continue;
      const own = dict.lookupMaybe(RESOURCES, PDFDict);
      if (!own || borrowsPageResources(own, seen)) return true;
    }
  }
  return false;
}

/** Whether a resource is drawn from a content stream of its own: a form, a Type 3 font, a tiling pattern. */
function drawsWithResources(category: string, dict: PDFDict): boolean {
  if (category === "XObject") return subtype(dict) === "Form";
  if (category === "Font") return subtype(dict) === "Type3";
  const patternType = dict.lookup(PDFName.of("PatternType"));
  return patternType instanceof PDFNumber && patternType.asNumber() === 1;
}

/**
 * What `findUnits` needs to know of a stream's resources (see `ResourceInfo`). Anything that cannot be read with
 * certainty is null, so the drawings using it are kept: a form without a usable BBox or Matrix, a Type 3 font (its
 * glyphs are drawings of any size), a font written vertically, a font whose widths are malformed.
 */
export function pdfResourceInfo(resources: PDFDict | undefined): ResourceInfo {
  return {
    xobject(name) {
      const object = entry(resources, "XObject", name);
      if (!(object instanceof PDFStream)) return null;
      const kind = subtype(object.dict);
      if (kind === "Image") return { subtype: "Image" };
      if (kind !== "Form") return null;
      const bbox = numbersOf(object.dict.lookup(PDFName.of("BBox")), 4);
      const matrixObject = object.dict.lookup(PDFName.of("Matrix"));
      const matrix = matrixObject === undefined ? IDENTITY : numbersOf(matrixObject, 6);
      return bbox && matrix ? { subtype: "Form", bbox: bbox as [number, number, number, number], matrix: matrix as Matrix } : null;
    },
    font(name) {
      const font = entry(resources, "Font", name);
      if (!(font instanceof PDFDict)) return null;
      const kind = subtype(font);
      if (kind === "Type0") return compositeFont(font);
      if (kind !== "Type1" && kind !== "MMType1" && kind !== "TrueType") return null;
      const widths = font.lookup(PDFName.of("Widths"));
      if (widths === undefined) return { widths: null, twoByte: false };
      const list = numbersOf(widths);
      const first = font.lookup(PDFName.of("FirstChar"));
      const descriptor = font.lookup(PDFName.of("FontDescriptor"));
      const missingObject = descriptor instanceof PDFDict ? descriptor.lookup(PDFName.of("MissingWidth")) : undefined;
      const missing = missingObject === undefined ? 0 : missingObject instanceof PDFNumber ? missingObject.asNumber() : NaN;
      if (!list || !(first instanceof PDFNumber) || !Number.isFinite(missing)) return null;
      return { widths: { first: first.asNumber(), list, missing }, twoByte: false };
    },
    shadingBBox(name) {
      const shading = entry(resources, "Shading", name);
      const dict = shading instanceof PDFStream ? shading.dict : shading instanceof PDFDict ? shading : undefined;
      return (numbersOf(dict?.lookup(PDFName.of("BBox")), 4) as [number, number, number, number] | null) ?? null;
    },
  };
}

/**
 * A Type 0 font, measured as two bytes a glyph at its widest width. Vertical writing (a `-V` CMap, or an embedded CMap
 * not known to be horizontal) cannot be measured this way.
 */
function compositeFont(font: PDFDict): ReturnType<ResourceInfo["font"]> {
  const encoding = font.lookup(PDFName.of("Encoding"));
  if (encoding instanceof PDFName) {
    if (encoding.decodeText().endsWith("-V")) return null;
  } else {
    const wmode = encoding instanceof PDFStream ? encoding.dict.lookup(PDFName.of("WMode")) : undefined;
    if (!(wmode instanceof PDFNumber && wmode.asNumber() === 0)) return null;
  }
  const descendants = font.lookup(PDFName.of("DescendantFonts"));
  const cid = descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
  if (!(cid instanceof PDFDict)) return null;
  const dwObject = cid.lookup(PDFName.of("DW"));
  const dw = dwObject === undefined ? 1000 : dwObject instanceof PDFNumber ? dwObject.asNumber() : NaN;
  const w = cid.lookup(PDFName.of("W"));
  const list = w === undefined ? [] : cidWidths(w);
  if (!list || !Number.isFinite(dw)) return null;
  return { widths: { first: 0, list, missing: dw }, twoByte: true };
}

/** The widths of a CID font's W array (`c [w …]` and `c_first c_last w` runs), or null when it is malformed. */
function cidWidths(w: PDFObject): number[] | null {
  if (!(w instanceof PDFArray)) return null;
  const widths: number[] = [];
  let i = 0;
  while (i < w.size()) {
    const next = w.lookup(i + 1);
    if (!(w.lookup(i) instanceof PDFNumber)) return null;
    if (next instanceof PDFArray) {
      const run = numbersOf(next);
      if (!run) return null;
      widths.push(...run);
      i += 2;
    } else {
      const width = w.lookup(i + 2);
      if (!(next instanceof PDFNumber) || !(width instanceof PDFNumber)) return null;
      widths.push(width.asNumber());
      i += 3;
    }
  }
  return widths.every(Number.isFinite) ? widths : null;
}

/** The resource `name` of `category` (e.g. "Font"), resolved. */
function entry(resources: PDFDict | undefined, category: string, name: string): PDFObject | undefined {
  return resources?.lookupMaybe(PDFName.of(category), PDFDict)?.lookup(nameKey(name));
}

function subtype(dict: PDFDict): string | undefined {
  return dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
}

/** An array of finite numbers (of `count` of them, when given), or null. */
function numbersOf(object: PDFObject | undefined, count?: number): number[] | null {
  if (!(object instanceof PDFArray) || (count !== undefined && object.size() !== count)) return null;
  const out: number[] = [];
  for (let i = 0; i < object.size(); i++) {
    const n = object.lookup(i);
    if (!(n instanceof PDFNumber) || !Number.isFinite(n.asNumber())) return null;
    out.push(n.asNumber());
  }
  return out;
}

function keysOf(dict: PDFDict | undefined): string[] {
  return dict ? dict.keys().map((k) => k.decodeText()) : [];
}

/** The names a content stream uses: every name token (the tokenizer gives them decoded). */
function namesUsed(content: Uint8Array): Set<string> {
  return new Set(tokenize(content).filter((t) => t.kind === "name").map((t) => t.value));
}

/** A name as written in a PDF: `/` and its characters, those that are not regular (and `#`) as `#xx`. */
function encodeName(name: string): string {
  let out = "/";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    const regular = code > 0x20 && code < 0x7f && !"()<>[]{}/%#".includes(ch);
    out += regular ? ch : `#${code.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The dictionary key for a decoded name (`PDFName.of` decodes `#xx` escapes, so the name goes in escaped). */
function nameKey(name: string): PDFName {
  return PDFName.of(encodeName(name).slice(1));
}

/** `bytes` with each edit's range replaced by its text. The edits are in order and do not overlap. */
function splice(bytes: Uint8Array, edits: { start: number; end: number; text: string }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const edit of edits) {
    if (edit.start < at) throw new TrimFallback("the page's drawings overlap");
    parts.push(bytes.subarray(at, edit.start), Uint8Array.from(edit.text, (c) => c.charCodeAt(0)));
    at = edit.end;
  }
  parts.push(bytes.subarray(at));
  return join(parts);
}

function join(parts: Uint8Array[], separator?: number): Uint8Array {
  const length = parts.reduce((sum, p) => sum + p.length, 0) + (separator === undefined ? 0 : Math.max(0, parts.length - 1));
  const out = new Uint8Array(length);
  let at = 0;
  for (const [i, part] of parts.entries()) {
    if (i > 0 && separator !== undefined) out[at++] = separator;
    out.set(part, at);
    at += part.length;
  }
  return out;
}
