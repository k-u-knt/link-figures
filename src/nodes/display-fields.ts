import { displayChannelsOf, seedDisplay, topValue, type DisplayChannel } from "../adjust/display";
import type { Plane } from "../links/decoders/tiff-convert";
import { isVectorFile } from "../links/intake-classify";
import { isLocked } from "../model/groups";
import { planeHistogram, type HistogramResult } from "../model/histogram";
import type { FileNode } from "../model/types";
import type { Field } from "../registry/fields";
import type { FieldRoute, InspectorContext } from "../registry/node-type";

/** The bins of the inspector's histogram: one per CSS px of its canvas. */
export const HISTOGRAM_BINS = 220;

/** A display field's key: `display.<channel>.<property>`. */
const KEY = /^display\.(\d+)\.(lut|min|max|gamma|visible|histogram)$/;

/** Whether `node` shows a picture that may have a display: an image panel, not a vector one, not shown as a badge. */
function showsSamples(node: FileNode, ctx?: InspectorContext): boolean {
  return node.show === "image" && !isVectorFile(node.file) && ctx?.imageStateNow?.(node.id) !== "none";
}

/** The "auto" seed of each plane, as drawing fills a channel the adjustment lacks: worked out once per plane (a cached plane is never changed). */
const autoSeeds = new WeakMap<Plane, DisplayChannel[]>();

/** A plane's "auto" seed, remembered. */
function autoSeedOf(plane: Plane): DisplayChannel[] {
  let seed = autoSeeds.get(plane);
  if (!seed) {
    seed = seedDisplay(plane, "auto");
    autoSeeds.set(plane, seed);
  }
  return seed;
}

/** What the Display section of panel `node` shows: its channels and the plane they come from (null when not decoded). */
interface Shown {
  channels: DisplayChannel[];
  plane: Plane | null;
}

/**
 * What the Display section shows for `node`, or null when it has none: a panel that shows no TIFF or raster picture, or
 * one whose samples are not decoded yet (null `samplesNow`, which starts their decode) and that has no display.
 */
function shownDisplay(node: FileNode, ctx?: InspectorContext): Shown | null {
  if (!showsSamples(node, ctx)) return null;
  const plane = ctx?.samplesNow?.(node.id) ?? null;
  const params = node.adjustments.find((a) => a.type === "display")?.params;
  if (!plane && !params) return null;
  const channels = displayChannelsOf(params, plane, node.range, autoSeedOf).slice(0, 3);
  return channels.length > 0 ? { channels, plane } : null;
}

/** Histograms worked out per plane, by channel and display range: a sync of the inspector does not count the samples again. */
const histograms = new WeakMap<Plane, Map<string, HistogramResult>>();

/** The histogram of channel `channel` of `plane` as `panel.histogram` gives it (through its helper), for the display `shown`. */
function histogramOf(plane: Plane, channel: number, shown: DisplayChannel): HistogramResult {
  let byKey = histograms.get(plane);
  if (!byKey) {
    byKey = new Map();
    histograms.set(plane, byKey);
  }
  const key = `${channel}|${shown.min}|${shown.max}`;
  let result = byKey.get(key);
  if (!result) {
    if (byKey.size >= 16) byKey.clear();
    result = planeHistogram(plane, channel, shown, HISTOGRAM_BINS);
    byKey.set(key, result);
  }
  return result;
}

/**
 * The Display section of a file panel (§7): a "Display" heading, then per channel a heading ("Grey", or
 * "Red"/"Green"/"Blue"), its LUT, min and max (native units), gamma, whether it is visible, and its histogram. None for
 * a panel that `shownDisplay` gives nothing for.
 */
export function displayFields(node: FileNode, ctx: InspectorContext): Field[] {
  const shown = shownDisplay(node, ctx);
  if (!shown) return [];
  const names = shown.channels.length === 1 ? ["Grey"] : ["Red", "Green", "Blue"];
  const luts = ctx.registries.luts.all().map((lut) => ({ value: lut.id, label: lut.name }));
  const top = shown.plane ? topValue(shown.plane) : undefined;
  const channelFields = shown.channels.flatMap((channel, c): Field[] => {
    const key = (prop: string) => `display.${c}.${prop}`;
    // A LUT that is not registered (an edited file) is listed as it is: it draws as grey until another is chosen.
    const options = luts.some((l) => l.value === channel.lut) ? luts : [...luts, { value: channel.lut, label: `${channel.lut} (not available)` }];
    return [
      { kind: "heading", key: `display.${c}`, label: names[c] ?? `Channel ${c + 1}` },
      { kind: "select", key: key("lut"), label: "LUT", options },
      { kind: "number", key: key("min"), label: "Min", min: 0, max: top, step: 1 },
      { kind: "number", key: key("max"), label: "Max", min: 0, max: top, step: 1 },
      { kind: "number", key: key("gamma"), label: "Gamma", min: 0.1, max: 10, step: 0.05 },
      { kind: "toggle", key: key("visible"), label: "Visible" },
      { kind: "histogram", key: key("histogram"), label: "Histogram" },
    ];
  });
  return [{ kind: "heading", key: "display", label: "Display", level: 1 }, ...channelFields];
}

/**
 * The display fields read what the section shows (the adjustment, or the seed of what the panel shows now) and are
 * written by `panel.display` on the first selected panel only (per-image ranges rarely match). The histogram field reads
 * the channel's histogram (`HistogramResult`), or null without samples.
 */
export function displayRoute(key: string): FieldRoute<FileNode> | undefined {
  const match = KEY.exec(key);
  if (!match) return undefined;
  const channel = Number(match[1]);
  const prop = match[2] as keyof DisplayChannel | "histogram";
  return {
    firstOnly: true,
    read: (node, ctx) => {
      const shown = shownDisplay(node, ctx);
      const current = shown?.channels[channel];
      if (!shown || !current) return undefined;
      if (prop === "histogram") return shown.plane ? histogramOf(shown.plane, channel, current) : null;
      return current[prop];
    },
    applies: (node, doc, ctx) => showsSamples(node, ctx) && !isLocked(doc, node.id),
    call: (node, value) => ({ id: "panel.display", args: { id: node.id, channel, set: { [prop]: value } } }),
  };
}
