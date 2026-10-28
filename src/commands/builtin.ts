import { MIN_NODE_PX } from "../constants";
import { joinLinktext } from "../format/links-section";
import { createPage, newId, textNodeDefaults } from "../model/defaults";
import { mmToPx, type PlacePoint } from "../model/geometry";
import { PAGE_PRESETS, getPreset } from "../model/presets";
import type { FileNode, Node, NodeId, Page, PageId } from "../model/types";
import type LinkFiguresPlugin from "../main";
import type { Command, CommandContext, FigureViewLike } from "../registry/command";
import { roundPx } from "../view/pointer-math";

/** How far a duplicate sits from its original, along both axes. */
const DUPLICATE_OFFSET_MM = 5;

/**
 * The figure view as the built-in commands use it: `FigureViewLike` plus what only the real view offers. The view a
 * command is given (`CommandContext.view`) is always that one, and `LinkFiguresView` implements this to keep it so.
 */
export interface EditorView extends FigureViewLike {
  /** What the Delete key does: removes the selected nodes that are not locked, and lets go of their links. Whether any went. */
  deleteSelection(): boolean;
  /** Opens a link target (`file`, `file#subpath`) from the figure's own place in the vault, as the badge on a node does. */
  openLink(linktext: string, newLeaf?: boolean): void;
  /** The natural size of the image a node shows, once it has loaded; rejects for a node that shows no image. */
  imageSize(id: NodeId): Promise<{ width: number; height: number }>;
  /** Tells a node what a double-click on it tells it (a text node starts editing). */
  activateNode(id: NodeId): void;
}

const editor = (ctx: CommandContext): EditorView => ctx.view as EditorView;

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

function stackCommand(id: string, name: string, icon: string, direction: "forward" | "backward"): Command {
  return {
    id,
    name,
    icon,
    group: "arrange",
    applies: (ctx) => ctx.selection.length > 0,
    run(ctx) {
      const { pages, nodes } = ctx.store.doc;
      const selected = new Set(ctx.selection);
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

/** A page like `current` (its preset, or its size when that is not a preset), to go after it; `existingIds` are the document's page ids. */
function pageLike(current: Page | undefined, existingIds: string[]): Page {
  const preset = current?.preset === undefined ? undefined : getPreset(current.preset);
  const page = createPage(preset?.id ?? PAGE_PRESETS[0].id, existingIds);
  if (current && !preset) {
    page.width = current.width;
    page.height = current.height;
    if (current.preset === undefined) delete page.preset;
    else page.preset = current.preset;
  }
  return page;
}

function duplicate(ctx: CommandContext): void {
  const { nodes } = ctx.store.doc;
  const selected = new Set(ctx.selection);
  // In stacking order, so the copies keep their order among themselves.
  const originals = nodes.filter((n) => selected.has(n.id)).sort((a, b) => a.z - b.z);
  if (originals.length === 0) return;

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
  ctx.store.commit("duplicate", (draft) => {
    draft.nodes.push(...copies);
  });
  ctx.view.setSelection(copies.map((c) => c.id));
}

function addPage(ctx: CommandContext): void {
  const { pages } = ctx.store.doc;
  const page = pageLike(ctx.page, pages.map((p) => p.id));
  const at = pages.findIndex((p) => p.id === ctx.page?.id);
  ctx.store.commit("add-page", (draft) => {
    draft.pages.splice(at === -1 ? draft.pages.length : at + 1, 0, page);
  });
}

function deletePage(ctx: CommandContext): void {
  const id = ctx.page?.id;
  if (id === undefined || ctx.store.doc.pages.length < 2) return;
  // One commit, so one undo brings the page back with everything on it. The node host lets go of the removed nodes' links.
  ctx.store.commit("delete-page", (draft) => {
    draft.pages = draft.pages.filter((p) => p.id !== id);
    draft.nodes = draft.nodes.filter((n) => n.page !== id);
  });
}

/** A new text node with its top-left at `at`, above everything on that page, selected and being edited. */
function placeText(ctx: CommandContext, at: PlacePoint): void {
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
  ctx.view.setSelection([node.id]);
  // The node host drew the label as the commit was made, so it is there to be told; typing replaces "Text".
  editor(ctx).activateNode(node.id);
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

/** Defined in the order the toolbar shows them within a group (the registry sorts by group, then by this order). */
function builtinCommands(): Command[] {
  // A tool: the toolbar button and the palette entry arm it, and the next press on a page places a label there.
  const text: Command = {
    id: "insert-text",
    name: "Text",
    icon: "type",
    group: "insert",
    cursor: "text",
    applies: (ctx) => !!ctx.page,
    run: (ctx) => ctx.view.armTool(text),
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
      applies: (ctx) => ctx.selection.length > 0,
      run: (ctx) => void editor(ctx).deleteSelection(),
    },
    { id: "duplicate", name: "Duplicate", icon: "copy", group: "edit", applies: (ctx) => ctx.selection.length > 0, run: duplicate },
    text,
    stackCommand("bring-forward", "Bring forward", "arrow-up", "forward"),
    stackCommand("send-backward", "Send backward", "arrow-down", "backward"),
    {
      id: "reset-aspect",
      name: "Reset aspect ratio",
      icon: "ratio",
      group: "arrange",
      applies: (ctx) => ctx.store.doc.nodes.some((n) => ctx.selection.includes(n.id) && isUnlockedImage(n)),
      run: resetAspect,
    },
    { id: "add-page", name: "Add page", icon: "file-plus", group: "page", applies: () => true, run: addPage },
    { id: "delete-page", name: "Delete page", icon: "file-minus", group: "page", applies: (ctx) => ctx.store.doc.pages.length > 1, run: deletePage },
    { id: "fit-page", name: "Fit page", icon: "maximize", group: "view", applies: () => true, run: (ctx) => ctx.view.fitPage() },
    { id: "zoom-100", name: "Zoom to 100%", icon: "search", group: "view", applies: () => true, run: (ctx) => ctx.view.zoomTo(1) },
    { id: "export", name: "Export", icon: "download", group: "export", applies: () => true, run: (ctx) => ctx.view.requestExport() },
    {
      id: "open-source",
      name: "Open source",
      icon: "link",
      group: "edit",
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
