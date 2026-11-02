import type { App, Hotkey } from "obsidian";
import type { PlacePoint } from "../model/geometry";
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
  /** Arms `command` (a command with `place`), in place of any other; arming the armed tool again disarms it. */
  armTool(command: Command): void;
  disarmTool(): void;
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
