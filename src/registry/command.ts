import type { App, Hotkey } from "obsidian";
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
