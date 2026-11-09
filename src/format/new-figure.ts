import { newFigureDocument } from "../model/defaults";
import { emptyParsed, serializeFigureFile } from "./serialize";

/**
 * A new figure file's text: `pages` empty pages (1 or more) of the page preset `presetId` (a known one). What the "New
 * figure" command and `api.createFigure` both write.
 */
export function newFigureText(presetId: string, pages: number): string {
  return serializeFigureFile(newFigureDocument(presetId, pages), emptyParsed());
}
