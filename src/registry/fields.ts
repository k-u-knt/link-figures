/** One inspector control. The inspector, and exporter option panels, are generated from lists of these. */
export type Field = {
  kind: "number" | "text" | "color" | "select" | "toggle";
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: "mm" | "pt" | "px" | "%";
  options?: { value: string; label: string }[];
};
