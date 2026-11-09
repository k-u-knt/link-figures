/** What a page's `paper` holds for "no paper": the sheet is clear, and only what is on it is drawn. */
export const TRANSPARENT_PAPER = "transparent";

/** Whether `paper` is no colour at all: `"transparent"`, or (from a hand-edited file) `"none"` or nothing. */
export function isTransparentPaper(paper: string): boolean {
  const text = paper.trim().toLowerCase();
  return text === "" || text === "none" || text === TRANSPARENT_PAPER;
}
