import { fileNodeDefaults } from "../model/defaults";
import type { FileNode, NodeId } from "../model/types";
import { extensionOf } from "../links/intake-classify";
import { isPanelExtension } from "../links/resolver";
import { CommandError, type Command, type CommandContext } from "../registry/command";
import type { ParamSpec } from "../registry/params";
import { addNode, creationPage, newNodeId, topOf } from "./drawing";

/**
 * The commands that make panels (file nodes). `panel.create` is how every panel comes to be: a drop or paste on the
 * stage (`links/intake`) runs it, as a script does, so the two make the same panels.
 */

/** What `panel.create` is given (see its params). */
export interface PanelCreateArgs {
  id?: string;
  /** The figure page's id; the view's when it is left out (headless it must be given). */
  page?: string;
  /** The link's file part, as a figure's links section holds it (a note without `.md`). */
  file: string;
  subpath?: string;
  show?: FileNode["show"];
  imageIndex?: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export const PANEL_CREATE_PARAMS: ParamSpec = {
  id: { type: "string" },
  page: { type: "string" },
  file: { type: "string", required: true },
  subpath: { type: "string", default: "" },
  show: { type: "string", enum: ["image", "content"] },
  imageIndex: { type: "integer", minimum: 0 },
  x: { type: "number", required: true },
  y: { type: "number", required: true },
  width: { type: "number", exclusiveMinimum: 0 },
  height: { type: "number", exclusiveMinimum: 0 },
};

/** What a panel of `file` shows when the call does not say: an image for an image, PDF or TIFF file, else the content (a note). */
export function defaultShow(file: string): FileNode["show"] {
  return isPanelExtension(extensionOf(file)) ? "image" : "content";
}

/**
 * A panel linking `file` + `subpath` with its top-left at `x`, `y` on its page, above everything there, at the default
 * size unless `width` and `height` say otherwise. The link is not required to resolve: one that leads nowhere (yet)
 * makes a panel that shows it is missing, as a drop of such a link does. Selected in an open view once it is in.
 */
export function createPanel(ctx: CommandContext, args: PanelCreateArgs): { id: NodeId } {
  const command = "panel.create";
  if (args.file === "") throw new CommandError(`${command}: "file" must not be empty`);
  const id = newNodeId(ctx, command, args.id);
  const page = creationPage(ctx, command, args);
  const doc = ctx.store.doc;
  const partial: Partial<FileNode> & Pick<FileNode, "file" | "subpath" | "show"> = {
    file: args.file,
    subpath: args.subpath ?? "",
    show: args.show ?? defaultShow(args.file),
    x: args.x,
    y: args.y,
    z: topOf(doc, page),
    ...(args.imageIndex !== undefined ? { imageIndex: args.imageIndex } : {}),
    ...(args.width !== undefined ? { width: args.width } : {}),
    ...(args.height !== undefined ? { height: args.height } : {}),
    ...(id !== undefined ? { id } : {}),
  };
  return addNode(ctx, command, fileNodeDefaults(page, partial, doc.nodes.map((n) => n.id)));
}

const always = () => true;

export function panelCommands(): Command[] {
  return [
    {
      id: "panel.create",
      name: "Create panel",
      icon: "image",
      group: "insert",
      hidden: true,
      params: PANEL_CREATE_PARAMS,
      applies: always,
      run: (ctx, args) => createPanel(ctx, args as unknown as PanelCreateArgs),
    },
  ];
}
