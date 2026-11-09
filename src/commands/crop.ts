import { clampCrop, cropKeepingImage } from "../model/geometry";
import { isLocked } from "../model/groups";
import type { Crop, FileNode, NodeId } from "../model/types";
import { CommandError, type Command, type CommandContext } from "../registry/command";
import type { ParamSpec } from "../registry/params";
import { editor, type EditorView } from "./builtin";

/** What `panel.crop` is given: the panel, the crop (null for the whole image), and what stays where it is. */
interface CropArgs {
  id: NodeId;
  crop: Crop | null;
  keep: "image" | "box";
}

const CROP_PARAMS: ParamSpec = {
  id: { type: "string", required: true },
  crop: {
    type: "object",
    required: true,
    nullable: true,
    properties: {
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      w: { type: "number", required: true },
      h: { type: "number", required: true },
    },
  },
  keep: { type: "string", enum: ["image", "box"], default: "image" },
};

/** The natural size of the image `id` shows, when the view has it now; null headless and before the image has loaded. */
function imageSizeNow(ctx: CommandContext, id: NodeId): { width: number; height: number } | null {
  const view = ctx.view as Partial<EditorView> | null;
  return view?.imageSizeNow?.(id) ?? null;
}

/** The file panel `id` of the figure, which may be changed; refuses anything else with a message naming `command`. */
function panel(ctx: CommandContext, command: string, id: NodeId): FileNode {
  const doc = ctx.store.doc;
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) throw new CommandError(`${command}: there is no node "${id}"`);
  if (node.type !== "file") throw new CommandError(`${command}: "${id}" is not a file panel`);
  if (node.show !== "image") throw new CommandError(`${command}: "${id}" shows no image`);
  if (isLocked(doc, id)) throw new CommandError(`${command}: "${id}" is locked`);
  return node;
}

/**
 * Sets a file panel's crop. With `keep: "image"` the image stays where it is on the page and at its scale, and the box
 * becomes the region the crop shows (`cropKeepingImage`), which needs the image's natural size; with `keep: "box"` the
 * box stays and the image refits. One commit, so one undo step.
 */
function crop(ctx: CommandContext, args: CropArgs): Record<string, never> {
  const node = panel(ctx, "panel.crop", args.id);
  const next = args.crop ? clampCrop(args.crop) : null;
  let fields: Partial<FileNode> = { crop: next };
  if (args.keep === "image") {
    const natural = imageSizeNow(ctx, node.id);
    if (!natural) throw new CommandError('panel.crop: the image size is not known yet; use keep "box"');
    fields = cropKeepingImage(node, natural, next);
  }
  ctx.store.commit("panel.crop", (draft) => {
    const target = draft.nodes.find((n) => n.id === node.id) as FileNode;
    Object.assign(target, fields);
  });
  return {};
}

/** The one selected file panel that has a crop and may be changed, if that is what is selected. */
function selectedCroppedPanel(ctx: CommandContext): FileNode | undefined {
  if (ctx.selection.length !== 1) return undefined;
  const node = ctx.store.doc.nodes.find((n) => n.id === ctx.selection[0]);
  return node?.type === "file" && node.show === "image" && node.crop !== null && !isLocked(ctx.store.doc, node.id) ? node : undefined;
}

/**
 * The one selected file panel that shows an image and may be changed, if that is what is selected: what `crop.edit`
 * crops on the page. A rotated one counts, so that the command can say why it does not start (see `startCrop`).
 */
function selectedImagePanel(ctx: CommandContext): FileNode | undefined {
  if (ctx.selection.length !== 1) return undefined;
  const node = ctx.store.doc.nodes.find((n) => n.id === ctx.selection[0]);
  return node?.type === "file" && node.show === "image" && !isLocked(ctx.store.doc, node.id) ? node : undefined;
}

/** `panel.crop`, `panel.crop-reset` and `crop.edit`. */
export function cropCommands(): Command[] {
  const commands: Command<any>[] = [
    {
      id: "panel.crop",
      name: "Crop",
      icon: "crop",
      group: "edit",
      hidden: true,
      params: CROP_PARAMS,
      applies: () => false,
      run: (ctx, args) => crop(ctx, args as CropArgs),
    },
    {
      id: "panel.crop-reset",
      name: "Reset crop",
      icon: "crop",
      group: "edit",
      params: { id: { type: "string" } },
      applies: (ctx) => selectedCroppedPanel(ctx) !== undefined,
      run: (ctx, args?: { id?: string }) => {
        const id = args?.id ?? selectedCroppedPanel(ctx)?.id;
        if (id === undefined) {
          if (!ctx.view) throw new CommandError('panel.crop-reset needs "id" when the figure is not open');
          return {};
        }
        return crop(ctx, { id, crop: null, keep: "image" });
      },
    },
    {
      id: "crop.edit",
      name: "Crop",
      icon: "crop",
      group: "edit",
      needsView: true,
      // Not before the image has loaded (a badge or a placeholder has nothing to crop).
      applies: (ctx) => {
        const node = selectedImagePanel(ctx);
        return node !== undefined && imageSizeNow(ctx, node.id) !== null;
      },
      run: (ctx) => {
        const node = selectedImagePanel(ctx);
        if (node) editor(ctx).startCrop(node.id);
      },
    },
  ];
  return commands;
}
