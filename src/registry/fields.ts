/**
 * One inspector control. The inspector, and exporter option panels, are generated from lists of these. `key` may be a
 * dotted path into the value (`"border.width"`, `"stroke.paint"`). A `paint` field is a paint-type select plus the chosen
 * type's own fields (keys relative to the paint); a `stops` field is a gradient's list of stops, with add and remove.
 *
 * A `heading` is a line of text that heads the fields after it (a display channel's name); it has no value. A heading
 * with `level` 1 heads a whole section (the Display section) and is drawn more strongly than the level-2 default. A
 * `histogram` is a display channel's histogram with its min and max handles (keys relative to the channel: its key is
 * `<channel>.histogram`, and it reads `<channel>.histogram` for the counts and writes `<channel>.min` and `<channel>.max`).
 *
 * Two options stand for a value that may be null (absent): a `toggle` with an `onValue` is on while the value is not
 * null, and writes a copy of `onValue` when turned on and null when turned off (a shape's border); a `color` that is
 * `nullable` has a checkbox beside it that does the same with the colour last shown (a pattern's background), or,
 * with none shown yet, its `onValue` colour (a page's paper is white).
 */
export type Field = {
  kind: "number" | "text" | "color" | "select" | "toggle" | "paint" | "stops" | "heading" | "histogram";
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: "mm" | "pt" | "px" | "%";
  options?: { value: string; label: string }[];
  onValue?: unknown;
  nullable?: boolean;
  /** For a `heading`: 1 for a section's heading, 2 (the default) for a heading within a section. */
  level?: 1 | 2;
  /**
   * For an export option: `end` draws it at the end of the Export dialog, after Pages and Resolution, rather than under
   * the Format menu (what the export writes besides the figure: the cards options).
   */
  placement?: "end";
};
