import type { Plane } from "./tiff-convert";

/** How many decoded planes are kept at most. */
export const SAMPLE_CACHE_PLANES = 4;
/** How many bytes of sample data (`data.byteLength`, summed) are kept at most. */
export const SAMPLE_CACHE_BYTES = 400e6;

/**
 * Decoded sample planes by key (see `samplesKey`), least recently used first out: at most `SAMPLE_CACHE_PLANES` planes
 * and `SAMPLE_CACHE_BYTES` of sample data. The newest plane is always kept, even one over the byte cap by itself.
 * A cached plane is shared: nothing may write into its samples.
 */
export class SampleCache {
  /** In use order: the first key is the least recently used. */
  private readonly entries = new Map<string, { plane: Plane; pageCount: number }>();
  private bytes = 0;

  /** The plane under `key`, which becomes the most recently used. */
  get(key: string): Plane | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.plane;
  }

  /** The page count of the file the plane under `key` came from (1 for a raster); does not count as a use. */
  pageCount(key: string): number | undefined {
    return this.entries.get(key)?.pageCount;
  }

  set(key: string, plane: Plane, pageCount = 1): void {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.plane.data.byteLength;
    }
    this.entries.set(key, { plane, pageCount });
    this.bytes += plane.data.byteLength;
    for (const [oldest, evicted] of this.entries) {
      if (this.entries.size <= 1 || (this.entries.size <= SAMPLE_CACHE_PLANES && this.bytes <= SAMPLE_CACHE_BYTES)) break;
      this.entries.delete(oldest);
      this.bytes -= evicted.plane.data.byteLength;
    }
  }
}
