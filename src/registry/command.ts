import type { App, Hotkey } from "obsidian";
import type { PlacePoint, Pt } from "../model/geometry";
import type { PathData } from "../model/path";
import type { DocumentStore } from "../model/store";
import type { NodeId, Page } from "../model/types";
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
 * release (`to`). Only items on the press page count; the tool decides what, if anything, it does with them.
 */
export interface DragTargets {
  from: NodeId[];
  to: NodeId[];
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
export type CommandStore = Pick<DocumentStore, "doc" | "commit" | "undo" | "redo" | "canUndo" | "canRedo">;

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
}

export type CommandGroup = "edit" | "insert" | "arrange" | "align" | "distribute" | "style" | "page" | "view" | "export";

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
  /** How the command's toolbar button shows the view's state now (a toggle's mode); without it the button is as the command is. */
  state?(ctx: CommandContext): CommandState;
  /** The CSS cursor over the stage while the tool is armed; `crosshair` when not given. */
  cursor?: string;
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
