import type { Plane } from "../links/decoders/tiff-convert";
import type { Field } from "./fields";

/** The image as decoded, at its native bit depth and samples. */
export type SampleImage = Plane;

/** 8-bit display pixels, four samples each. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

interface AdjustmentBase {
  id: string;
  name: string;
  /** The params a newly added adjustment starts with. */
  defaults(): Record<string, unknown>;
  fields(params: Record<string, unknown>): Field[];
}

/** Turns native samples into display pixels (at most one per panel; it replaces the default mapping). */
export interface MapAdjustmentType extends AdjustmentBase {
  stage: "map";
  apply(image: SampleImage, params: Record<string, unknown>): RgbaImage;
}

/** Changes display pixels already mapped to 8 bits. */
export interface PixelAdjustmentType extends AdjustmentBase {
  stage: "pixel";
  apply(image: RgbaImage, params: Record<string, unknown>): RgbaImage;
}

export type AdjustmentType = MapAdjustmentType | PixelAdjustmentType;

export class AdjustmentRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly types = new Map<string, AdjustmentType>();

  register(t: AdjustmentType): void {
    this.types.set(t.id, t);
  }

  get(id: string): AdjustmentType | undefined {
    return this.types.get(id);
  }

  all(): AdjustmentType[] {
    return [...this.types.values()];
  }
}
