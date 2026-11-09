/**
 * The TIFF page `pageIndex` names: truncated, at least 0 (NaN is 0), and at most the last of `pageCount` pages. Kept
 * apart from the decoder (no UTIF import) so the resolver can key samples by it.
 */
export function tiffPageIndex(pageIndex: number, pageCount = Infinity): number {
  return Math.min(Math.max(Math.trunc(pageIndex) || 0, 0), pageCount - 1);
}
