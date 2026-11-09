/**
 * Counts `values` in `bins` equal bins over [lo, hi]: a value v falls in bin floor((v − lo) / (hi − lo) · bins), and a
 * value at or beyond either end in the end bin, so every value is counted once. With `invertBits` (8 or 16; 0 for none)
 * each value is first turned into (2^bits − 1) − v, the value a `whiteIsZero` plane shows. When `hi` does not exceed
 * `lo` the interval is widened to [lo − 0.5, lo + 0.5], so every value is still counted.
 */
export function histogram(values: ArrayLike<number>, invertBits: number, bins: number, lo: number, hi: number): number[] {
  const counts = new Array<number>(bins).fill(0);
  if (!(hi > lo)) {
    hi = lo + 0.5;
    lo -= 0.5;
  }
  const top = invertBits > 0 ? 2 ** invertBits - 1 : 0;
  const scale = bins / (hi - lo);
  for (let i = 0; i < values.length; i++) {
    const v = invertBits > 0 ? top - values[i] : values[i];
    const bin = Math.floor((v - lo) * scale);
    counts[bin < 0 ? 0 : bin >= bins ? bins - 1 : bin]++;
  }
  return counts;
}

/**
 * The `sat`% and (100 − `sat`)% values of `values` (whole numbers from 0 to 65535), as ImageJ's "Auto" saturates
 * that share at each end: sorted, min is the value at index low = floor(n · sat / 100) (with a little slack, so a
 * product that is a whole number in exact arithmetic is not lost to rounding) and max the one at n − 1 − low. No values
 * give 0..0.
 */
export function percentiles(values: ArrayLike<number>, sat: number): { min: number; max: number } {
  const n = values.length;
  if (n === 0) return { min: 0, max: 0 };
  let top = 0;
  for (let i = 0; i < n; i++) if (values[i] > top) top = values[i];
  const counts = new Uint32Array(top + 1);
  for (let i = 0; i < n; i++) counts[values[i]]++;
  const low = Math.min(n - 1, Math.floor((n * sat) / 100 + 1e-9));
  const high = Math.max(low, n - 1 - low);
  /** The value at sorted index `index`. */
  const at = (index: number): number => {
    let seen = 0;
    for (let v = 0; v <= top; v++) {
      seen += counts[v];
      if (seen > index) return v;
    }
    return top;
  };
  return { min: at(low), max: at(high) };
}
