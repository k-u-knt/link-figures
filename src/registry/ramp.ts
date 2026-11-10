import type { Paint, Stop } from "../model/types";
import type { Field } from "./fields";

/**
 * Where a ramp's colours are laid: along a line (`{ kind: "linear", angle }`) or out from a centre (`{ kind: "radial",
 * cx, cy, r }`). A plugin's geometry has a kind of its own and whatever values it needs.
 */
export type RampGeometry = { kind: string } & Record<string, unknown>;

/**
 * A colour as one thing to edit: a ramp of colour stops, sorted by offset (0-1). One stop is a solid colour; two or
 * more are a gradient laid out by `geometry` (which a solid keeps only while it is edited: it is not written).
 */
export interface ColorRamp {
  stops: Stop[];
  geometry: RampGeometry;
}

/**
 * One way of laying a ramp out (linear, radial…). It writes a ramp of two or more stops as its paint, and names the
 * paint's own fields the inspector shows under the colour slider (keys relative to the paint, as `PaintType.fields`).
 */
export interface RampGeometryType {
  kind: string;
  /** The toggle's text ("Linear"). */
  name: string;
  /** The geometry a ramp gets when the user switches to this kind. */
  defaults(): RampGeometry;
  fields(): Field[];
  /** The paint for `stops` (sorted, two or more) laid out by `geometry`; `previous`, when it is this kind's paint, keeps its other keys. */
  toPaint(stops: Stop[], geometry: RampGeometry, previous?: Paint): Paint;
}

/** An entry of the colour slider's presets menu: a new ramp from the current one and the selected stop's index. */
export interface RampPreset {
  id: string;
  name: string;
  apply(ramp: ColorRamp, selected: number): ColorRamp;
}

export class RampGeometryRegistry {
  // Re-registering a kind replaces it in place and keeps its position.
  private readonly kinds = new Map<string, RampGeometryType>();

  register(g: RampGeometryType): void {
    this.kinds.set(g.kind, g);
  }

  get(kind: string): RampGeometryType | undefined {
    return this.kinds.get(kind);
  }

  all(): RampGeometryType[] {
    return [...this.kinds.values()];
  }
}

export class RampPresetRegistry {
  // Re-registering an id replaces it in place and keeps its position.
  private readonly presets = new Map<string, RampPreset>();

  register(p: RampPreset): void {
    this.presets.set(p.id, p);
  }

  get(id: string): RampPreset | undefined {
    return this.presets.get(id);
  }

  all(): RampPreset[] {
    return [...this.presets.values()];
  }
}
