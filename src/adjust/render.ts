import { planeToRgba } from "../links/decoders/tiff-convert";
import type { FileNode } from "../model/types";
import type { AdjustmentRegistry, RgbaImage, SampleImage } from "../registry/adjustment";

/** What decides a panel's pixels beyond its source: the default display range and the adjustments. */
export type PixelRecipe = Pick<FileNode, "range" | "adjustments">;

/** Just the recipe of a node, so the stage and the export hand the decoders the same thing. */
export function recipeOf(node: PixelRecipe): PixelRecipe {
  return { range: node.range, adjustments: node.adjustments };
}

/**
 * True when any adjustment that is switched on is also registered, so that drawing would change a pixel (a type that
 * is not registered is skipped when drawing). Without one, a panel takes the path it took before adjustments existed.
 */
export function hasActiveAdjustments(recipe: PixelRecipe, registry: AdjustmentRegistry): boolean {
  return recipe.adjustments.some((a) => a.enabled && registry.get(a.type) !== undefined);
}

/**
 * The one rendering path of the stage and the export: samples to colour, then colour to colour. The first enabled
 * map adjustment maps the native samples (flat planes included); without one, `planeToRgba` maps them by
 * `recipe.range`. Then each enabled pixel adjustment runs in list order. A type that is not registered is skipped and
 * reported to `onUnknown` once per call. `image` is never changed: pixel adjustments work on the mapped copy.
 */
export function renderSamples(image: SampleImage, recipe: PixelRecipe, registry: AdjustmentRegistry, onUnknown?: (type: string) => void): RgbaImage {
  const unknown = new Set<string>();
  const known = recipe.adjustments.filter((a) => {
    if (!a.enabled) return false;
    if (registry.get(a.type)) return true;
    if (!unknown.has(a.type)) {
      unknown.add(a.type);
      onUnknown?.(a.type);
    }
    return false;
  });

  let mapped: RgbaImage | undefined;
  for (const a of known) {
    const type = registry.get(a.type);
    if (type?.stage === "map") {
      mapped = type.apply(image, a.params);
      break;
    }
  }
  let out = mapped ?? { width: image.width, height: image.height, data: planeToRgba(image, recipe.range).rgba };
  for (const a of known) {
    const type = registry.get(a.type);
    if (type?.stage === "pixel") out = type.apply(out, a.params);
  }
  return out;
}
