import { createDocument } from "../../../src/model/defaults";
import type { Document } from "../../../src/model/types";
import { builtinPaintTypes } from "../../../src/paint/builtin";
import { createRegistries } from "../../../src/registry";
import type { PptxContext } from "../../../src/registry/node-type";
import { builtinShapeKinds } from "../../../src/shapes/builtin";

/** A PptxContext for one slide of `doc` (one A4 page by default), recording its warnings and media. */
export function pptxContext(over: Partial<PptxContext> = {}, doc: Document = createDocument("a4-portrait")) {
  const registries = createRegistries();
  for (const paint of builtinPaintTypes) registries.paints.register(paint);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  const warnings: string[] = [];
  const media: { bytes: Uint8Array; ext: string }[] = [];
  let id = 1;
  const scale = over.scale ?? 1;
  const ctx: PptxContext = {
    registries,
    doc,
    page: doc.pages[0],
    scale,
    px: (value) => Math.round(value * 9525 * scale),
    dpi: 300,
    addMedia(bytes, ext) {
      media.push({ bytes, ext });
      return `rId${media.length + 1}`;
    },
    nextId: () => ++id,
    rasterise: async () => new Uint8Array(),
    warn: (message) => warnings.push(message),
    ...over,
  };
  return { ctx, warnings, media };
}
