import type { App, Hotkey } from "obsidian";
import type { PlacePoint } from "../model/geometry";
import type { DocumentStore } from "../model/store";
import type { NodeId, Page } from "../model/types";

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

export interface CommandContext {
  app: App;
  view: FigureViewLike;
  store: DocumentStore;
  selection: NodeId[];
  page: Page;
}

export type CommandGroup = "edit" | "insert" | "arrange" | "align" | "distribute" | "style" | "page" | "view" | "export";

/** Display order of groups in the toolbar, context menu and palette. */
export const GROUP_ORDER: CommandGroup[] = ["edit", "insert", "arrange", "align", "distribute", "style", "page", "view", "export"];

export interface Command {
  id: string;
  name: string;
  icon?: string;
  group: CommandGroup;
  hotkeys?: Hotkey[];
  applies(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void | Promise<void>;
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
