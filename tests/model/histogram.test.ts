import { describe, expect, it } from "vitest";
import { histogram, percentiles } from "../../src/model/histogram";

describe("histogram", () => {
  it("splits [lo, hi] into equal bins, the top value in the last bin", () => {
    expect(histogram(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]), 0, 4, 0, 8)).toEqual([2, 2, 2, 2]);
    expect(histogram(Uint8Array.from([0, 10, 10]), 0, 2, 0, 10)).toEqual([1, 2]);
  });

  it("counts every value, clamping those outside [lo, hi] to the end bins", () => {
    const counts = histogram(Uint16Array.from([0, 100, 500, 1000, 65535]), 0, 8, 100, 1000);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
    expect(counts[0]).toBe(2);
    expect(counts[7]).toBe(2);
  });

  it("inverts against 2^bits − 1 when invertBits is given", () => {
    expect(histogram(Uint8Array.from([255, 255, 0]), 8, 2, 0, 255)).toEqual([2, 1]);
  });

  it("widens an empty or reversed interval by ±0.5 itself, so every value is counted", () => {
    expect(histogram(Uint8Array.from([5, 5]), 0, 3, 5, 5)).toEqual([0, 2, 0]);
    expect(histogram(Uint8Array.from([5, 6, 7]), 0, 4, 9, 2).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("puts a flat channel widened by ±0.5 in the middle bin", () => {
    expect(histogram(Uint16Array.from([700, 700]), 0, 3, 699.5, 700.5)).toEqual([0, 2, 0]);
  });
});

describe("percentiles", () => {
  it("gives the sat% and (100 − sat)% values", () => {
    const values = Uint16Array.from({ length: 1000 }, (_, i) => 999 - i);
    expect(percentiles(values, 0.35)).toEqual({ min: 3, max: 996 });
    expect(percentiles(values, 0)).toEqual({ min: 0, max: 999 });
  });

  it("keeps an index that is a whole number in exact arithmetic (n = 22000, 0.35%)", () => {
    const values = Uint16Array.from({ length: 22000 }, (_, i) => i);
    expect(percentiles(values, 0.35)).toEqual({ min: 77, max: 21922 });
  });

  it("gives 0..0 for no values", () => {
    expect(percentiles(new Uint8Array(0), 0.35)).toEqual({ min: 0, max: 0 });
  });
});
