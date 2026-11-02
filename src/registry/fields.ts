/**
 * One inspector control. The inspector, and exporter option panels, are generated from lists of these. `key` may be a
 * dotted path into the value (`"border.width"`, `"stroke.paint"`). A `paint` field is a paint-type select plus the chosen
 * type's own fields (keys relative to the paint); a `stops` field is a gradient's list of stops, with add and remove.
 *
 * Two options stand for a value that may be null (absent): a `toggle` with an `onValue` is on while the value is not
 * null, and writes a copy of `onValue` when turned on and null when turned off (a shape's border); a `color` that is
 * `nullable` has a checkbox beside it that does the same with the colour last shown (a pattern's background).
 */
export type Field = {
  kind: "number" | "text" | "color" | "select" | "toggle" | "paint" | "stops";
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: "mm" | "pt" | "px" | "%";
  options?: { value: string; label: string }[];
  onValue?: unknown;
  nullable?: boolean;
};
