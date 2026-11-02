/**
 * One inspector control. The inspector, and exporter option panels, are generated from lists of these. `key` may be a
 * dotted path into the value (`"border.width"`, `"stroke.paint"`). A `paint` field is a paint-type select plus the chosen
 * type's own fields (keys relative to the paint); a `stops` field is a gradient's list of stops, with add and remove.
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
};
