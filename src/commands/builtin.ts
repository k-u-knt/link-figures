import { resolveConnector } from "../connectors/geometry";
import { MIN_NODE_PX } from "../constants";
import { joinLinktext } from "../format/links-section";
import { createPage, newId, textNodeDefaults } from "../model/defaults";
import { mmToPx, type PlacePoint } from "../model/geometry";
import { PAGE_PRESETS, getPreset } from "../model/presets";
import type { End, FileNode, Node, NodeId, Page, PageId } from "../model/types";
import type LinkFiguresPlugin from "../main";
import { CommandError, type Command, type CommandContext, type FigureViewLike } from "../registry/command";
import type { ParamSpec } from "../registry/params";
import { CUSTOM_PRESET, clampPageSize } from "../view/page-fields";
import { roundPx } from "../view/pointer-math";

/** How far a duplicate sits from its original, along both axes. */
const DUPLICATE_OFFSET_MM = 5;

/**
 * The figure view as the built-in commands use it: `FigureViewLike` plus what only the real view offers. The view a
 * command is given (`CommandContext.view`) is always that one, and `LinkFiguresView` implements this to keep it so.
 */
export interface EditorView extends FigureViewLike {
  /** Opens a link target (`file`, `file#subpath`) from the figure's own place in the vault, as the badge on a node does. */
  openLink(linktext: string, newLeaf?: boolean): void;
  /** The natural size of the image a node shows, once it has loaded; rejects for a node that shows no image. */
  imageSize(id: NodeId): Promise<{ width: number; height: number }>;
  /** Tells a node what a double-click on it tells it (a text node starts editing). */
  activateNode(id: NodeId): void;
  /** The largest width or height a page may have, in millimetres (the Maximum page size setting). */
  pageLimitMm(): number;
  /** Says that a page size had to be cut down to `limitMm` (the view shows a notice, as the inspector's edits do). */
  notePageLimit(limitMm: number): void;
}

/** The view a `needsView` command acts on; the API refuses such a command headless, so this only guards against a slip. */
function editor(ctx: CommandContext): EditorView {
  if (!ctx.view) throw new CommandError("this command needs the figure to be open");
  return ctx.view as EditorView;
}

/** Does `fn`, a side effect on the view, once the edit is in: at once, or within a batch after the batch commits. */
function whenCommitted(ctx: CommandContext, fn: () => void): void {
  if (ctx.afterCommit) ctx.afterCommit(fn);
  else fn();
}

/** The arguments of a command that acts on nodes: `ids` names them, in place of the selection. */
type NodesArgs = { ids?: unknown[] };

/** The parameters of a command that acts on nodes. */
const NODES_PARAMS: ParamSpec = { ids: { type: "array" } };

/**
 * The nodes a command acts on: `args.ids` when the call names them, else the selection. Headless there is no selection,
 * so the ids must be given. A given id that is not a node of the figure is an error, so a script learns of its slip.
 */
function targetIds(ctx: CommandContext, command: string, args: NodesArgs | undefined): NodeId[] {
  const ids = args?.ids;
  if (ids === undefined) {
    if (!ctx.view) throw new CommandError(`${command} needs "ids" when the figure is not open`);
    return ctx.selection;
  }
  const present = new Set(ctx.store.doc.nodes.map((n) => n.id));
  for (const id of ids) {
    if (typeof id !== "string") throw new CommandError(`parameter "ids" must hold node ids (strings)`);
    if (!present.has(id)) throw new CommandError(`${command}: there is no node "${id}"`);
  }
  return ids as NodeId[];
}

/** The page a page-level command acts on: the one `args.page` names, else the view's focus page; undefined when neither is. */
function targetPage(ctx: CommandContext, command: string, args: { page?: unknown } | undefined): Page | undefined {
  if (args?.page === undefined) return ctx.page;
  const page = ctx.store.doc.pages.find((p) => p.id === args.page);
  if (!page) throw new CommandError(`${command}: there is no page "${String(args.page)}"`);
  return page;
}

/** The parameters of a page-level command. */
const PAGE_PARAMS: ParamSpec = { page: { type: "string" } };

/**
 * The new `z` of the nodes that move one place up (`forward`) or down (`backward`) the stack of one page: each
 * selected node trades places with the nearest node past it that is not selected, so a selected block moves as a
 * block. `nodes` are one page's, in document order, which settles the order of nodes that share a `z`. Empty when
 * nothing moves (the selection is already at that end of the stack).
 */
export function restack(
  nodes: readonly Pick<Node, "id" | "z">[],
  selected: ReadonlySet<NodeId>,
  direction: "forward" | "backward",
): Map<NodeId, number> {
  const order = nodes.map((n, index) => ({ id: n.id, z: n.z, index })).sort((a, b) => a.z - b.z || a.index - b.index);
  const zs = order.map((n) => n.z);
  let moved = false;
  const swap = (i: number, j: number): void => {
    [order[i], order[j]] = [order[j], order[i]];
    moved = true;
  };
  if (direction === "forward") {
    for (let i = order.length - 2; i >= 0; i--) if (selected.has(order[i].id) && !selected.has(order[i + 1].id)) swap(i, i + 1);
  } else {
    for (let i = 1; i < order.length; i++) if (selected.has(order[i].id) && !selected.has(order[i - 1].id)) swap(i, i - 1);
  }
  const changes = new Map<NodeId, number>();
  if (!moved) return changes;
  // The places keep the `z` they had, so a swap trades two values; places that shared one are pulled apart, or moving past a tie would show nothing.
  let previous = -Infinity;
  order.forEach((n, i) => {
    const z = zs[i] > previous ? zs[i] : previous + 1;
    previous = z;
    if (z !== n.z) changes.set(n.id, z);
  });
  return changes;
}

function stackCommand(id: string, name: string, icon: string, direction: "forward" | "backward"): Command<NodesArgs> {
  return {
    id,
    name,
    icon,
    group: "arrange",
    params: NODES_PARAMS,
    applies: (ctx) => ctx.selection.length > 0,
    run(ctx, args) {
      const { pages, nodes } = ctx.store.doc;
      const selected = new Set(targetIds(ctx, id, args));
      const changes = new Map<NodeId, number>();
      for (const page of pages) {
        for (const [nodeId, z] of restack(nodes.filter((n) => n.page === page.id), selected, direction)) changes.set(nodeId, z);
      }
      if (changes.size === 0) return;
      ctx.store.commit(id, (draft) => {
        for (const node of draft.nodes) {
          const z = changes.get(node.id);
          if (z !== undefined) node.z = z;
        }
      });
    },
  };
}

/**
 * A page like `current` (its preset, or its size when that is not a preset), to go after it; `existingIds` are the
 * document's page ids. A width or height over `limitMm` is cut down to it, which makes the page custom; `clamped` says
 * whether that happened.
 */
function pageLike(current: Page | undefined, existingIds: string[], limitMm: number): { page: Page; clamped: boolean } {
  const preset = current?.preset === undefined ? undefined : getPreset(current.preset);
  const page = createPage(preset?.id ?? PAGE_PRESETS[0].id, existingIds);
  if (current && !preset) {
    page.width = current.width;
    page.height = current.height;
    if (current.preset === undefined) delete page.preset;
    else page.preset = current.preset;
  }
  const width = clampPageSize(page.width, limitMm);
  const height = clampPageSize(page.height, limitMm);
  const clamped = width.clamped || height.clamped;
  page.width = width.value;
  page.height = height.value;
  // A preset whose size was cut down is no longer that preset.
  if (clamped && page.preset !== undefined) page.preset = CUSTOM_PRESET;
  return { page, clamped };
}

/**
 * Copies the nodes (`args.ids`, else the selection) a little down and to the right, above everything on their pages;
 * from the selection, the copies become the selection. A copied connector's end that is attached to a node copied in
 * the same call is attached to that node's copy; one attached to a node that is not copied becomes a free end where it
 * is drawn now, moved by the same offset as the copies.
 */
function duplicate(ctx: CommandContext, args?: NodesArgs): { ids: NodeId[] } {
  const doc = ctx.store.doc;
  const { nodes } = doc;
  const selected = new Set(targetIds(ctx, "duplicate", args));
  // In stacking order, so the copies keep their order among themselves.
  const originals = nodes.filter((n) => selected.has(n.id)).sort((a, b) => a.z - b.z);
  if (originals.length === 0) return { ids: [] };

  const taken = new Set(nodes.map((n) => n.id));
  const tops = new Map<PageId, number>();
  for (const n of nodes) tops.set(n.page, Math.max(tops.get(n.page) ?? -Infinity, n.z));
  const offset = mmToPx(DUPLICATE_OFFSET_MM);

  const copies = originals.map((original): Node => {
    const id = newId("p", taken);
    taken.add(id);
    const z = (tops.get(original.page) ?? -1) + 1;
    tops.set(original.page, z);
    return { ...structuredClone(original), id, x: roundPx(original.x + offset), y: roundPx(original.y + offset), z };
  });
  const copyOf = new Map(originals.map((original, i) => [original.id, copies[i].id]));
  copies.forEach((copy, i) => {
    const original = originals[i];
    if (copy.type !== "connector" || original.type !== "connector") return;
    const resolved = resolveConnector(doc, original, ctx.registries);
    copy.ends = copy.ends.map((end, which): End => {
      if (end.kind === "free") return { kind: "free", x: roundPx(end.x + offset), y: roundPx(end.y + offset) };
      const target = copyOf.get(end.node);
      if (target !== undefined) return { ...end, node: target };
      const { pt } = resolved.ends[which];
      return { kind: "free", x: roundPx(pt.x + offset), y: roundPx(pt.y + offset) };
    }) as [End, End];
  });
  ctx.store.commit("duplicate", (draft) => {
    draft.nodes.push(...copies);
  });
  const ids = copies.map((c) => c.id);
  const view = ctx.view;
  if (view && args?.ids === undefined) whenCommitted(ctx, () => view.setSelection(ids));
  return { ids };
}

/** Removes the nodes (`args.ids`, else the selection) that are not locked; a locked node stays, as with the Delete key. */
function deleteNodes(ctx: CommandContext, args?: NodesArgs): { ids: NodeId[] } {
  const named = new Set(targetIds(ctx, "delete", args));
  const ids = ctx.store.doc.nodes.filter((n) => named.has(n.id) && !n.locked).map((n) => n.id);
  if (ids.length === 0) return { ids };
  const gone = new Set(ids);
  // The node host lets go of the removed nodes' links.
  ctx.store.commit("delete", (draft) => {
    draft.nodes = draft.nodes.filter((node) => !gone.has(node.id));
  });
  return { ids };
}

/**
 * Adds a page like `args.page` (else the focus page) after it; headless with no page named, like the last page, at the
 * end. In a view a size over the Maximum page size setting is cut down to it; headless the page copied is one the figure
 * already has, so it is not cut.
 */
function addPage(ctx: CommandContext, args?: { page?: unknown }): { id: PageId } {
  const { pages } = ctx.store.doc;
  const after = targetPage(ctx, "add-page", args) ?? pages[pages.length - 1];
  const limit = ctx.view ? editor(ctx).pageLimitMm() : Infinity;
  const { page, clamped } = pageLike(after, pages.map((p) => p.id), limit);
  const at = pages.findIndex((p) => p.id === after?.id);
  ctx.store.commit("add-page", (draft) => {
    draft.pages.splice(at === -1 ? draft.pages.length : at + 1, 0, page);
  });
  if (clamped) whenCommitted(ctx, () => editor(ctx).notePageLimit(limit));
  return { id: page.id };
}

/** Removes a page (`args.page`, else the focus page) and everything on it; never the last page. Headless the page must be named. */
function deletePage(ctx: CommandContext, args?: { page?: unknown }): void {
  const page = targetPage(ctx, "delete-page", args);
  if (!page && !ctx.view) throw new CommandError(`delete-page needs "page" when the figure is not open`);
  const id = page?.id;
  if (id === undefined || ctx.store.doc.pages.length < 2) return;
  // One commit, so one undo brings the page back with everything on it. The node host lets go of the removed nodes' links.
  ctx.store.commit("delete-page", (draft) => {
    draft.pages = draft.pages.filter((p) => p.id !== id);
    draft.nodes = draft.nodes.filter((n) => n.page !== id);
  });
}

/** A new text node with its top-left at `at`, above everything on that page, selected and being edited. */
function placeText(ctx: CommandContext, at: PlacePoint): void {
  const view = editor(ctx);
  const { page } = at;
  const { nodes } = ctx.store.doc;
  const node = textNodeDefaults(page, {}, nodes.map((n) => n.id));
  node.x = roundPx(at.x);
  node.y = roundPx(at.y);
  node.z = nodes.reduce((top, n) => (n.page === page.id ? Math.max(top, n.z) : top), -1) + 1;
  // Not "insert": a drop's commit just before must stay an undo step of its own.
  ctx.store.commit("insert-text", (draft) => {
    draft.nodes.push(node);
  });
  view.setSelection([node.id]);
  // The node host drew the label as the commit was made, so it is there to be told; typing replaces "Text".
  view.activateNode(node.id);
}

/** The one file node with a link that is selected, if that is what is selected. */
function linkedFileNode(ctx: CommandContext): Extract<Node, { type: "file" }> | undefined {
  if (ctx.selection.length !== 1) return undefined;
  const node = ctx.store.doc.nodes.find((n) => n.id === ctx.selection[0]);
  return node?.type === "file" && node.file !== "" ? node : undefined;
}

/** Whether `node` is a file node that shows an image and may be changed: the kind of panel whose box can follow its image. */
function isUnlockedImage(node: Node | undefined): node is FileNode {
  return node?.type === "file" && node.show === "image" && !node.locked;
}

/**
 * Gives each selected image panel the height its image has at the panel's width: the image's own aspect ratio, or the
 * crop's when the panel shows a part of it. A panel whose image size is not known (it is missing, or could not be
 * loaded) is left as it is. One commit, so one undo step; none when no height changes.
 */
async function resetAspect(ctx: CommandContext): Promise<void> {
  const view = editor(ctx);
  const selected = new Set(ctx.selection);
  const panels = ctx.store.doc.nodes.filter((n): n is FileNode => selected.has(n.id) && isUnlockedImage(n));
  const sizes = new Map<NodeId, { width: number; height: number }>();
  await Promise.all(
    panels.map(async (panel) => {
      try {
        sizes.set(panel.id, await view.imageSize(panel.id));
      } catch {
        // No image to take the aspect ratio from.
      }
    }),
  );
  if (sizes.size === 0) return;
  // The image can take a while to load, so the panels are looked up again: one may have been deleted, locked or reshaped meanwhile.
  ctx.store.commit("reset-aspect", (draft) => {
    for (const node of draft.nodes) {
      const size = sizes.get(node.id);
      if (!size || !isUnlockedImage(node)) continue;
      const aspect = ((node.crop?.w ?? 1) * size.width) / ((node.crop?.h ?? 1) * size.height);
      // A crop with no area has no aspect ratio.
      if (!Number.isFinite(aspect) || aspect <= 0) continue;
      node.height = Math.max(MIN_NODE_PX, roundPx(node.width / aspect));
    }
  });
}

/**
 * Defined in the order the toolbar shows them within a group (the registry sorts by group, then by this order). Those
 * that act on the selection, the zoom, a tool or a dialog are `needsView`; the rest can run headless through the API.
 */
function builtinCommands(): Command[] {
  // A tool: the toolbar button and the palette entry arm it, and the next press on a page places a label there.
  const text: Command = {
    id: "insert-text",
    name: "Text",
    icon: "type",
    group: "insert",
    cursor: "text",
    needsView: true,
    applies: (ctx) => !!ctx.page,
    run: (ctx) => editor(ctx).armTool(text),
    place: placeText,
  };
  return [
    { id: "undo", name: "Undo", icon: "undo", group: "edit", applies: (ctx) => ctx.store.canUndo(), run: (ctx) => void ctx.store.undo() },
    { id: "redo", name: "Redo", icon: "redo", group: "edit", applies: (ctx) => ctx.store.canRedo(), run: (ctx) => void ctx.store.redo() },
    {
      id: "delete",
      name: "Delete",
      icon: "trash",
      group: "edit",
      params: NODES_PARAMS,
      applies: (ctx) => ctx.store.doc.nodes.some((n) => ctx.selection.includes(n.id) && !n.locked),
      run: deleteNodes,
    },
    { id: "duplicate", name: "Duplicate", icon: "copy", group: "edit", params: NODES_PARAMS, applies: (ctx) => ctx.selection.length > 0, run: duplicate },
    text,
    stackCommand("bring-forward", "Bring forward", "arrow-up", "forward"),
    stackCommand("send-backward", "Send backward", "arrow-down", "backward"),
    {
      id: "reset-aspect",
      name: "Reset aspect ratio",
      icon: "ratio",
      group: "arrange",
      needsView: true,
      applies: (ctx) => ctx.store.doc.nodes.some((n) => ctx.selection.includes(n.id) && isUnlockedImage(n)),
      run: resetAspect,
    },
    { id: "add-page", name: "Add page", icon: "file-plus", group: "page", params: PAGE_PARAMS, applies: () => true, run: addPage },
    {
      id: "delete-page",
      name: "Delete page",
      icon: "file-minus",
      group: "page",
      params: PAGE_PARAMS,
      applies: (ctx) => ctx.store.doc.pages.length > 1,
      run: deletePage,
    },
    { id: "fit-page", name: "Fit page", icon: "maximize", group: "view", needsView: true, applies: () => true, run: (ctx) => editor(ctx).fitPage() },
    { id: "zoom-100", name: "Zoom to 100%", icon: "search", group: "view", needsView: true, applies: () => true, run: (ctx) => editor(ctx).zoomTo(1) },
    { id: "export", name: "Export", icon: "download", group: "export", needsView: true, applies: () => true, run: (ctx) => editor(ctx).requestExport() },
    {
      id: "open-source",
      name: "Open source",
      icon: "link",
      group: "edit",
      needsView: true,
      applies: (ctx) => linkedFileNode(ctx) !== undefined,
      run(ctx) {
        const node = linkedFileNode(ctx);
        if (node) editor(ctx).openLink(joinLinktext(node.file, node.subpath));
      },
    },
  ];
}

/**
 * Puts the built-in commands in the registry, which the toolbar is generated from, and in Obsidian's command palette,
 * where each acts on the active figure view. None has a default hotkey: the stage's own key handler owns Cmd+Z,
 * Shift+Cmd+Z and Delete, and the same keys on a palette command would act twice.
 */
export function registerBuiltinCommands(plugin: LinkFiguresPlugin): void {
  for (const command of builtinCommands()) {
    plugin.registries.commands.register(command);
    plugin.addCommand({
      id: `lf-${command.id}`,
      // Obsidian puts the plugin's name in front of this in the palette ("Link Figures: Fit page"), and its id in front of the id.
      name: command.name,
      checkCallback: (checking) => {
        const view = plugin.activeFigureView();
        if (!view || view.readOnly || !command.applies(view.commandContext())) return false;
        if (!checking) view.runCommand(command);
        return true;
      },
    });
  }
}
