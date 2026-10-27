export interface PagePreset {
  id: string;
  name: string;
  /** mm */
  width: number;
  /** mm */
  height: number;
}

export const PAGE_PRESETS: PagePreset[] = [
  { id: "nature-single", name: "Nature - single column", width: 89, height: 170 },
  { id: "nature-1.5", name: "Nature - 1.5 column", width: 120, height: 170 },
  { id: "nature-double", name: "Nature - double column", width: 183, height: 170 },
  { id: "elsevier-single", name: "Elsevier - single column", width: 90, height: 240 },
  { id: "elsevier-1.5", name: "Elsevier - 1.5 column", width: 140, height: 240 },
  { id: "elsevier-double", name: "Elsevier - double column", width: 190, height: 240 },
  { id: "cell-single", name: "Cell - single column", width: 85, height: 225 },
  { id: "cell-1.5", name: "Cell - 1.5 column", width: 114, height: 225 },
  { id: "cell-double", name: "Cell - double column", width: 174, height: 225 },
  { id: "a4-portrait", name: "A4 portrait", width: 210, height: 297 },
  { id: "a4-landscape", name: "A4 landscape", width: 297, height: 210 },
  { id: "letter-portrait", name: "US Letter portrait", width: 215.9, height: 279.4 },
  { id: "letter-landscape", name: "US Letter landscape", width: 279.4, height: 215.9 },
  { id: "slide-16-9", name: "Slide 16:9", width: 338.7, height: 190.5 },
  { id: "slide-4-3", name: "Slide 4:3", width: 254, height: 190.5 },
];

export function getPreset(id: string): PagePreset | undefined {
  return PAGE_PRESETS.find((p) => p.id === id);
}
