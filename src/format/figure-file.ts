import { FILE_SUFFIX, FRONTMATTER_KEY } from "../constants";

/** Front matter as the metadata cache gives it (`CachedMetadata.frontmatter`), or none. */
export type FrontMatter = Record<string, unknown> | null | undefined;

/** True when `frontmatter` carries the figure marker (the `link-figures` key). */
export function hasMarker(frontmatter: FrontMatter): boolean {
  return frontmatter?.[FRONTMATTER_KEY] !== undefined;
}

/**
 * True when the file at `path` is a figure: it has the figure suffix (`.lnkfig.md`), or its front matter, as the
 * metadata cache read it, carries the figure marker. The one test of "is this a figure file" for what must never treat
 * a figure as a note (a block id written into it, a rename followed through it).
 */
export function isFigure(path: string, frontmatter: FrontMatter): boolean {
  return path.endsWith(FILE_SUFFIX) || hasMarker(frontmatter);
}
