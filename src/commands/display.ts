import { channelSamples, displayChannelsOf, topValue, type DisplayChannel } from "../adjust/display";
import type { Plane } from "../links/decoders/tiff-convert";
import { extensionOf } from "../links/intake-classify";
import { sourceKindOf } from "../links/resolver";
import { percentiles, planeHistogram, type HistogramResult } from "../model/histogram";
import type { FileNode, NodeId } from "../model/types";
import { CommandError, type Command, type CommandContext } from "../registry/command";
import type { ParamSpec } from "../registry/params";
import type { EditorView } from "./builtin";
import { panelGuard, selectedImagePanel } from "./crop";

/** The adjustment type these commands write. */
const DISPLAY = "display";

/** ImageJ's "Auto": the share of samples (%) let saturate at each end. */
const DEFAULT_SATURATION = 0.35;

interface DisplayArgs {
  id: NodeId;
  channel: number;
  set: Partial<DisplayChannel>;
}

interface AutoArgs {
  id?: NodeId;
  channel?: number;
  saturation: number;
}

interface HistogramArgs {
  id: NodeId;
  channel: number;
  bins: number;
}

export type { HistogramResult };

const DISPLAY_PARAMS: ParamSpec = {
  id: { type: "string", required: true },
  channel: { type: "integer", minimum: 0, default: 0 },
  set: {
    type: "object",
    required: true,
    properties: {
      min: { type: "number" },
      max: { type: "number" },
      gamma: { type: "number", minimum: 0.1, maximum: 10 },
      lut: { type: "string" },
      visible: { type: "boolean" },
    },
  },
};

const AUTO_PARAMS: ParamSpec = {
  id: { type: "string" },
  channel: { type: "integer", minimum: 0 },
  saturation: { type: "number", minimum: 0, default: DEFAULT_SATURATION },
};

const HISTOGRAM_PARAMS: ParamSpec = {
  id: { type: "string", required: true },
  channel: { type: "integer", minimum: 0, default: 0 },
  bins: { type: "integer", minimum: 1, maximum: 4096, default: 256 },
};

/** Whether panel `node` shows a vector source (SVG or PDF), which has no samples to display. */
function isVector(node: FileNode): boolean {
  const kind = sourceKindOf(extensionOf(node.file));
  return kind === "svg" || kind === "pdf";
}

/** The file panel `id` showing a TIFF or raster image that may be changed; refuses anything else, naming `command`. */
function imagePanel(ctx: CommandContext, command: string, id: NodeId): FileNode {
  const node = panelGuard(ctx, command, id);
  if (isVector(node)) throw new CommandError(`${command}: "${id}" is a vector panel`);
  return node;
}

/** The decoded samples of panel `id` if the view has them now; null headless and before they are decoded. */
function samplesNow(ctx: CommandContext, id: NodeId): Plane | null {
  const view = ctx.view as Partial<EditorView> | null;
  return view?.samplesNow?.(id) ?? null;
}

/** The samples of panel `id`, or a refusal naming `command` when they are not there (headless, or not decoded yet). */
function requireSamples(ctx: CommandContext, command: string, id: NodeId): Plane {
  const plane = samplesNow(ctx, id);
  if (!plane) throw new CommandError(`${command}: the image is not loaded; open the figure`);
  return plane;
}

/** The panel's `display` adjustment, if it has one. */
function displayOf(node: FileNode) {
  return node.adjustments.find((a) => a.type === DISPLAY);
}

/**
 * The channels the panel's display draws with now, one per channel of `plane`: the adjustment's own, with any missing
 * or malformed one filled as drawing fills it (the plane's "auto" seed); without an adjustment, the seed of what the
 * panel shows by its `range` (§10.1). Headless (no plane) only an existing adjustment's channels are known.
 */
function currentChannels(command: string, node: FileNode, plane: Plane | null): DisplayChannel[] {
  const existing = displayOf(node);
  if (!plane && !existing) throw new CommandError(`${command}: the image is not loaded; open the figure`);
  return displayChannelsOf(existing?.params, plane, node.range);
}

/** Refuses `channel` unless `channels` has it. */
function checkChannel(command: string, channel: number, count: number): void {
  if (channel >= count) throw new CommandError(`${command}: channel ${channel} is out of range (the image has ${count} channel${count === 1 ? "" : "s"})`);
}

/** The highest sample value of the panel's image: from the plane, or headless 255 for a raster file and 65535 for a TIFF. */
function topOf(node: FileNode, plane: Plane | null): number {
  if (plane) return topValue(plane);
  return sourceKindOf(extensionOf(node.file)) === "raster" ? 255 : 65535;
}

/**
 * Writes `channels` as the panel's `display` adjustment in one commit named `command`: patched in place when there is
 * one (and switched on, so an edit to a disabled one is never a silent no-op), else inserted first (it maps the
 * samples, so it runs before any pixel adjustment). Other adjustments are kept.
 */
function writeDisplay(ctx: CommandContext, command: string, id: NodeId, channels: DisplayChannel[]): void {
  ctx.store.commit(command, (draft) => {
    const target = draft.nodes.find((n) => n.id === id) as FileNode;
    const params = { channels: channels.map((c) => ({ ...c })) };
    const index = target.adjustments.findIndex((a) => a.type === DISPLAY);
    if (index === -1) target.adjustments.unshift({ type: DISPLAY, enabled: true, params });
    else target.adjustments[index] = { ...target.adjustments[index], enabled: true, params: { ...target.adjustments[index].params, ...params } };
  });
}

/** The values the user sees of `channel` (inverted for a `whiteIsZero` plane), as `channelSamples` gives them raw. */
function visibleSamples(plane: Plane, channel: number): ArrayLike<number> {
  const { values, invert } = channelSamples(plane, channel);
  if (!invert) return values;
  const top = topValue(plane);
  const out = plane.bitsPerSample === 8 ? new Uint8Array(values.length) : new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = top - values[i];
  return out;
}

/** `panel.display`: patches one channel of the panel's display, creating it seeded from what the panel shows (§5, §10.1). */
function display(ctx: CommandContext, args: DisplayArgs): Record<string, never> {
  const command = "panel.display";
  const node = imagePanel(ctx, command, args.id);
  const plane = samplesNow(ctx, node.id);
  const channels = currentChannels(command, node, plane);
  checkChannel(command, args.channel, channels.length);
  const { min, max, gamma, lut, visible } = args.set;
  if (lut !== undefined && !ctx.registries.luts.get(lut)) throw new CommandError(`${command}: there is no LUT "${lut}"`);
  const top = topOf(node, plane);
  const clamp = (v: number): number => Math.min(top, Math.max(0, v));
  const channel = { ...channels[args.channel] };
  if (min !== undefined) channel.min = clamp(min);
  if (max !== undefined) channel.max = clamp(max);
  if (gamma !== undefined) channel.gamma = gamma;
  if (lut !== undefined) channel.lut = lut;
  if (visible !== undefined) channel.visible = visible;
  channels[args.channel] = channel;
  writeDisplay(ctx, command, node.id, channels);
  return {};
}

/** `panel.display-auto`: one channel's (or every channel's) min and max set to the saturating percentiles of its samples. */
function auto(ctx: CommandContext, id: NodeId, channel: number | undefined, saturation: number): Record<string, never> {
  const command = "panel.display-auto";
  const node = imagePanel(ctx, command, id);
  if (!(saturation < 50)) throw new CommandError(`${command}: "saturation" must be less than 50`);
  const plane = requireSamples(ctx, command, node.id);
  const channels = currentChannels(command, node, plane);
  if (channel !== undefined) checkChannel(command, channel, channels.length);
  for (const c of channel === undefined ? channels.keys() : [channel]) {
    const { min, max } = percentiles(visibleSamples(plane, c), saturation);
    channels[c] = { ...channels[c], min, max };
  }
  writeDisplay(ctx, command, node.id, channels);
  return {};
}

/** `panel.display-reset`: removes the panel's display adjustment; nothing to do when it has none. */
function reset(ctx: CommandContext, id: NodeId): Record<string, never> {
  const command = "panel.display-reset";
  const node = imagePanel(ctx, command, id);
  if (!displayOf(node)) return {};
  ctx.store.commit(command, (draft) => {
    const target = draft.nodes.find((n) => n.id === node.id) as FileNode;
    target.adjustments = target.adjustments.filter((a) => a.type !== DISPLAY);
  });
  return {};
}

/** `panel.histogram`: counts of one channel's visible values over [min(data, display), max(data, display)] (§10.2). */
function histogramOf(ctx: CommandContext, args: HistogramArgs): HistogramResult {
  const command = "panel.histogram";
  const node = imagePanel(ctx, command, args.id);
  const plane = requireSamples(ctx, command, node.id);
  const channels = currentChannels(command, node, plane);
  checkChannel(command, args.channel, channels.length);
  return planeHistogram(plane, args.channel, channels[args.channel], args.bins);
}

/** The one selected panel showing a TIFF or raster image that may be changed, if that is what is selected. */
function selectedDisplayPanel(ctx: CommandContext): FileNode | undefined {
  const node = selectedImagePanel(ctx);
  return node && !isVector(node) ? node : undefined;
}

/** `panel.display`, `panel.display-auto`, `panel.display-reset` and `panel.histogram`. */
export function displayCommands(): Command[] {
  const commands: Command<any>[] = [
    {
      id: "panel.display",
      name: "Display",
      icon: "contrast",
      group: "style",
      hidden: true,
      params: DISPLAY_PARAMS,
      applies: () => false,
      run: (ctx, args) => display(ctx, args as DisplayArgs),
    },
    {
      id: "panel.display-auto",
      name: "Auto display range",
      icon: "contrast",
      group: "style",
      params: AUTO_PARAMS,
      applies: (ctx) => selectedDisplayPanel(ctx) !== undefined,
      run: (ctx, args?: AutoArgs) => {
        const id = args?.id ?? selectedDisplayPanel(ctx)?.id;
        if (id === undefined) {
          if (!ctx.view) throw new CommandError('panel.display-auto needs "id" when the figure is not open');
          return {};
        }
        return auto(ctx, id, args?.channel, args?.saturation ?? DEFAULT_SATURATION);
      },
    },
    {
      id: "panel.display-reset",
      name: "Reset display",
      icon: "image-off",
      group: "style",
      params: { id: { type: "string" } },
      applies: (ctx) => {
        const node = selectedDisplayPanel(ctx);
        return node !== undefined && displayOf(node) !== undefined;
      },
      run: (ctx, args?: { id?: string }) => {
        const id = args?.id ?? selectedDisplayPanel(ctx)?.id;
        if (id === undefined) {
          if (!ctx.view) throw new CommandError('panel.display-reset needs "id" when the figure is not open');
          return {};
        }
        return reset(ctx, id);
      },
    },
    {
      id: "panel.histogram",
      name: "Histogram",
      icon: "bar-chart",
      group: "style",
      hidden: true,
      params: HISTOGRAM_PARAMS,
      applies: () => false,
      run: (ctx, args) => histogramOf(ctx, args as HistogramArgs),
    },
  ];
  return commands;
}
