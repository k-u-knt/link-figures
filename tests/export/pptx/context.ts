import { createDocument } from "../../../src/model/defaults";
import type { Document } from "../../../src/model/types";
import { builtinPaintTypes } from "../../../src/paint/builtin";
import { createRegistries } from "../../../src/registry";
import type { PptxContext } from "../../../src/registry/node-type";
import { builtinShapeKinds } from "../../../src/shapes/builtin";
import { builtinCapKinds, builtinRoutes } from "../../../src/connectors/builtin";
import { connectorNodeType } from "../../../src/nodes/connector-node";
import { fileNodeType } from "../../../src/nodes/file-node";
import { groupNodeType } from "../../../src/nodes/group-node";
import { shapeNodeType } from "../../../src/nodes/shape-node";
import { textNodeType } from "../../../src/nodes/text-node";

/** Registries as the plugin fills them at load (node types, paints, shape kinds, routes, caps). */
export function pptxRegistries() {
  const registries = createRegistries();
  for (const type of [fileNodeType, textNodeType, shapeNodeType, connectorNodeType, groupNodeType]) registries.nodeTypes.register(type);
  for (const paint of builtinPaintTypes) registries.paints.register(paint);
  for (const kind of builtinShapeKinds) registries.shapes.register(kind);
  for (const route of builtinRoutes) registries.routes.register(route);
  for (const cap of builtinCapKinds) registries.caps.register(cap);
  return registries;
}

/** What the fake `rasterise` draws: a PNG signature and nothing more. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PptxContext for one slide of `doc` (one A4 page by default), recording its warnings and media. */
export function pptxContext(over: Partial<PptxContext> = {}, doc: Document = createDocument("a4-portrait")) {
  const registries = pptxRegistries();
  const warnings: string[] = [];
  const media: { bytes: Uint8Array; ext: string }[] = [];
  const rasterised: { fragment: string; box: { x: number; y: number; width: number; height: number } }[] = [];
  let id = 1;
  const scale = over.scale ?? 1;
  const ctx: PptxContext = {
    registries,
    doc,
    page: doc.pages[0],
    assets: new Map(),
    scale,
    px: (value) => Math.round(value * 9525 * scale),
    dpi: 300,
    addMedia(bytes, ext) {
      media.push({ bytes, ext });
      return `rId${media.length + 1}`;
    },
    nextId: () => ++id,
    rasterise: async (fragment, box) => {
      rasterised.push({ fragment, box });
      return PNG_BYTES;
    },
    warn: (message) => warnings.push(message),
    ...over,
  };
  return { ctx, warnings, media, rasterised };
}
