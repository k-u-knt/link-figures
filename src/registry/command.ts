import type { App, Hotkey } from "obsidian";
import type { PlacePoint, Pt } from "../model/geometry";
import type { PathData } from "../model/path";
import type { DocumentStore } from "../model/store";
import type { NodeId, Page, PageId } from "../model/types";
import type { Registries } from "./index";
import type { ParamSpec } from "./params";

/**
 * A command's failure that is the caller's to fix (a bad argument, an unknown node, a command that needs the figure
 * open): its message is meant to be read by whoever made the call, a person or a script.
 */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/** The slice of the figure view that commands may use; keeps commands testable without a real view. */
export interface FigureViewLike {
  file: { path: string } | null;
  /**
   * The nodes their plugin's `migrate` hook could not read when the figure was loaded (see `loadDocument`), and their
   * copies since: drawn as placeholders and skipped by an export. It only grows, so undoing and redoing a copy keeps it.
   */
  unreadableNodes?: ReadonlySet<NodeId>;
  /** Adds `ids` (copies of unreadable nodes) to `unreadableNodes`. */
  markUnreadable?(ids: NodeId[]): void;
  selectedIds(): NodeId[];
  currentPage(): Page;
  setSelection(ids: NodeId[]): void;
  fitPage(): void;
  zoomTo(z: number): void;
  requestExport(): void;
  /** The tool that the next press on a page places, or null. */
  armedTool: Command | null;
  /** Arms `command` (a command with `place` or `placeDrag`), in place of any other; arming the armed tool again disarms it. */
  armTool(command: Command): void;
  disarmTool(): void;
  /**
   * Runs the registered command `id` with the JSON `args`, as the API runs it on an open figure: checked against its
   * params and an undo step of its own. A failure is shown to the user rather than lost. Tools run their edits this way,
   * so a tool and a script make the same document.
   */
  runCommandById(id: string, args?: Record<string, unknown>, step?: UndoStep): void;
  /** A setting of this view that is not part of the figure (a tool's mode), or undefined when it has not been set. */
  viewOption(key: string): unknown;
  /** Sets a view setting (see `viewOption`); the toolbar is drawn again, so a button showing it shows the new value. */
  setViewOption(key: string, value: unknown): void;
}

/**
 * How a call's edit is kept in the undo history: "own", a step of its own (the default); "start", a step that the calls
 * after it may merge into; "continue", merged into the step before when that is the same command's, made moments ago
 * (a drag's moves, consecutive nudges), as the store merges commits.
 */
export type UndoStep = "own" | "start" | "continue";

/**
 * The items under the two points of a tool's drag, each list topmost first: under the press (`from`) and under the
 * release (`to`). Only items on the press page count; the tool decides what, if anything, it does with them. `reach`
 * is how near (page px) a point must come to a snap point to take it (see `SNAP_REACH_PX`).
 */
export interface DragTargets {
  from: NodeId[];
  to: NodeId[];
  reach: number;
  /**
   * The page whose paper is under the press (`fromPage`) and under the release (`toPage`), any page of the figure, or
   * null over no paper; absent when not known. A tool may tie an end there (the Connector tool: a card's association).
   */
  fromPage?: PageId | null;
  toPage?: PageId | null;
}

/**
 * What an armed tool draws over the page under the pointer, in that page's px: `path`, the outline of what a drag
 * would make (a connector's line), and `marks`, points worth showing (the anchors of the item under the pointer).
 */
export interface ToolPreview {
  path?: PathData;
  marks?: Pt[];
}

/** How a command's toolbar button shows the view's current state; each part left out stays as the command has it. */
export interface CommandState {
  name?: string;
  icon?: string;
  /** Shown pressed. */
  active?: boolean;
}

/**
 * What commands edit the document through: the figure's store, or within a batch a stand-in that applies each commit
 * to the batch's one draft (see `commands/headless`).
 */
export type CommandStore = Pick<DocumentStore, "doc" | "commit" | "undo" | "redo" | "canUndo" | "canRedo"> & {
  /** The store's unreadable nodes (see `DocumentStore.unreadable`): what `unreadableIn` falls back to. */
  readonly unreadable?: Set<NodeId>;
};

export interface CommandContext {
  app: App;
  registries: Registries;
  /** The figure's view, or null when the command runs headless (through the API, with the figure not open). */
  view: FigureViewLike | null;
  store: CommandStore;
  /** The view's selection; empty when headless. */
  selection: NodeId[];
  /** The page that page-level commands act on: the view's focus page, or undefined when headless. */
  page: Page | undefined;
  /**
   * Given within a batch: runs `fn` (a side effect on the view, such as a selection) once the batch has committed, and
   * never when it fails. Without it a command does such things at once.
   */
  afterCommit?(fn: () => void): void;
  /**
   * Headless: the Maximum page size setting, in mm, which a page size a command writes keeps to (`DEFAULT_PAGE_LIMIT_MM`
   * when absent). A view's own setting is read from the view (`pageLimitMm` in commands/builtin.ts).
   */
  pageLimitMm?: number;
  /**
   * The nodes their plugin's `migrate` hook could not read when the figure was loaded (see `loadDocument`), and their
   * copies since: open, the view's `unreadableNodes`; headless, those of the file as this call loaded it. No hook of
   * their type is called on them (read it through `unreadableIn`). Absent, every node is read by its type.
   */
  unreadable?: ReadonlySet<NodeId>;
  /** Adds `ids` (copies of unreadable nodes) to `unreadable`, so the calls after this one treat them alike. */
  markUnreadable?(ids: NodeId[]): void;
  /**
   * The link text the figure writes in text for a link to `file` (a node's link: a path or a name): Obsidian's link
   * text for the file it finds from the figure's place in the vault, in the user's link format, or `file` itself when
   * it finds none. Absent (a context made without a vault), `file` as it is.
   */
  linktext?(file: string): string;
}

/**
 * The nodes that `ctx`'s commands must not hand to their type's hooks: `CommandContext.unreadable`, else the store's own
 * set (`DocumentStore.unreadable`), so a context made without it still keeps the promise.
 */
export function unreadableIn(ctx: Pick<CommandContext, "unreadable" | "store">): ReadonlySet<NodeId> | undefined {
  return ctx.unreadable ?? ctx.store.unreadable;
}

/** Adds `ids` (copies of unreadable nodes) to `ctx`'s unreadable nodes: by `markUnreadable`, else to the store's set. */
export function markUnreadableIn(ctx: Pick<CommandContext, "markUnreadable" | "store">, ids: NodeId[]): void {
  if (ctx.markUnreadable) ctx.markUnreadable(ids);
  else for (const id of ids) ctx.store.unreadable?.add(id);
}

export type CommandGroup = "edit" | "insert" | "arrange" | "align" | "distribute" | "style" | "page" | "view" | "export";

/**
 * Where a right-click opens the context menu: over an item (`item`), over a page's paper (`page`), or over the canvas
 * outside the pages (`canvas`).
 */
export type MenuPlace = "item" | "page" | "canvas";

/** Display order of groups in the toolbar, context menu and palette. */
export const GROUP_ORDER: CommandGroup[] = ["edit", "insert", "arrange", "align", "distribute", "style", "page", "view", "export"];

/**
 * One thing a person can do to a figure, which a toolbar button, the palette, a tool, or a script through the plugin
 * API all run the same way. `A` is the JSON arguments (`params` describes them) and `R` the JSON result.
 */
export interface Command<A = unknown, R = unknown> {
  id: string;
  name: string;
  icon?: string;
  group: CommandGroup;
  hotkeys?: Hotkey[];
  /** The arguments the command takes; calls are checked against it before `run`. None means it takes none. */
  params?: ParamSpec;
  /**
   * True for a command that means nothing without arguments (`shape.create`, `node.update`): the toolbar shows no button
   * for it. The UI's own code (the tools, the inspector) and scripts run it.
   */
  hidden?: boolean;
  /** True for a command that acts on what only an open view has (the selection, the zoom, a tool, a dialog); the API refuses it headless. */
  needsView?: boolean;
  applies(ctx: CommandContext): boolean;
  /** `args` are the validated arguments (with defaults filled in) when the command has `params`; a UI call gives none. */
  run(ctx: CommandContext, args?: A): R | void | Promise<R | void>;
  /**
   * Makes the command a tool: its `run` arms it (`ctx.view.armTool`), and the next press on a page calls this with
   * the point pressed, once, and disarms it. Escape, or a press off every page, disarms it without placing anything.
   */
  place?(ctx: CommandContext, at: PlacePoint): void;
  /**
   * Makes the command a tool that is dragged out, as `place` makes one that is pressed: the press and the release on a
   * page call this once, with the two points on the press page (a release beyond it, over another page or none, is
   * clamped to it), whether Shift was held at the release, and the items under the press and the release (`targets`),
   * and disarm it. A click that does not travel (3 screen px or less) gives `to` equal to `from`.
   */
  placeDrag?(ctx: CommandContext, from: PlacePoint, to: PlacePoint, mods: { shift: boolean }, targets: DragTargets): void;
  /**
   * What a `placeDrag` tool shows while it is armed: with `from` null, for the pointer hovering at `to`; during a drag,
   * for the drag from `from` to `to` (as `placeDrag` would be given them). Null, or a tool without it, shows the dragged
   * box as the drag's preview and nothing while hovering.
   */
  preview?(ctx: CommandContext, from: PlacePoint | null, to: PlacePoint, targets: DragTargets): ToolPreview | null;
  /**
   * Whether the tool takes a press off the paper (on the canvas round the pages), where a tool without it is put down,
   * as it is when this says false. `at` is the press on the page the item under the pointer is placed against (a card
   * beside a page), else on the page whose paper is nearest, outside that page's paper; `under` is that page's items
   * under the pointer, topmost first. A `placeDrag` tool pressed there is not clamped to the paper at the release.
   */
  pressOffPaper?(ctx: CommandContext, at: PlacePoint, under: NodeId[]): boolean;
  /**
   * Chosen from a context menu, the tool is placed at the menu's point (`place`, as a press there would place it), rather
   * than armed. Without it a tool chosen from a menu is armed, as from the toolbar.
   */
  placeFromMenu?: true;
  /** How the command's toolbar button shows the view's state now (a toggle's mode); without it the button is as the command is. */
  state?(ctx: CommandContext): CommandState;
  /** The CSS cursor over the stage while the tool is armed; `crosshair` when not given. */
  cursor?: string;
  /**
   * The context menus the command is listed in (see `MenuPlace`); none when not given. A hidden command is never listed,
   * and one that does not apply is listed disabled.
   */
  menu?: MenuPlace[];
  /**
   * The item bar (see `view/item-bar`): the node types (NodeType ids, `["card"]`) whose bar lists the command when one
   * item of that type is selected. A hidden command is listed too, as the bar gives it its arguments: a command with an
   * `id` parameter is run with `{ id: <the item> }` (and a choice's parameter, see `itemBarChoice`); any other is run
   * as a toolbar button runs it, on the selection (the item). One that does not apply is shown disabled.
   */
  itemBar?: string[];
  /** Where the command sits in the bar: lower first; without it, after those that have one, in the registry's order. */
  itemBarOrder?: number;
  /** Whether the bar shows the command for item `id` now (a text card's Edit, a note card's Convert); without it, always. */
  itemBarShows?(ctx: CommandContext, id: NodeId): boolean;
  /** Makes the command's bar entry a dropdown of choices for item `id` (the Page dropdown), rather than a button. */
  itemBarChoice?(ctx: CommandContext, id: NodeId): ItemBarChoice;
}

/** A dropdown in the item bar: choosing an option runs its command with `{ id: <the item>, [param]: <its value> }`. */
export interface ItemBarChoice {
  /** The command's parameter the chosen value is given in. */
  param: string;
  options: { value: string | null; label: string }[];
  /** The value of the option shown chosen; undefined shows `mixed` (several apply), as a disabled entry. */
  value: string | null | undefined;
  /** What is shown when no one option is chosen (`value` undefined). */
  mixed?: string;
}

export class CommandRegistry {
  // A Map keeps registration order, and re-setting an existing id keeps its original position.
  private readonly commands = new Map<string, Command>();

  register(c: Command): void {
    this.commands.set(c.id, c);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /** Sorted by `GROUP_ORDER`, then by registration order (the sort is stable). */
  all(): Command[] {
    return [...this.commands.values()].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }

  applicable(ctx: CommandContext): Command[] {
    return this.all().filter((c) => c.applies(ctx));
  }
}
