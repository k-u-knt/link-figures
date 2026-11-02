import type { App } from "obsidian";
import { prepareCall, runBatch, runCall, withHeadlessFigure, type Call, type FigureFiles } from "./commands/headless";
import type { DocumentStore } from "./model/store";
import type { Document } from "./model/types";
import type { Registries } from "./registry";
import { CommandError, type CommandContext } from "./registry/command";
import type { ParamSpec } from "./registry/params";

/** A command as `commands()` describes it to a caller. */
export interface CommandInfo {
  id: string;
  name: string;
  group: string;
  params?: ParamSpec;
  needsView: boolean;
}

/**
 * The plugin's API (`plugin.api`), for other plugins and for scripts (the Obsidian CLI's `eval`): everything the
 * toolbar does, by command id with JSON arguments and JSON results. A figure is named by its vault path.
 */
export interface LinkFiguresApi {
  /** Every registered command, with its parameters and whether it needs the figure open. */
  commands(): CommandInfo[];
  /**
   * Runs one command on the figure: on the most recently active open view of it (one undo step there), or, with none
   * open, on the file itself, which is read, changed and saved (no history). Rejects with `CommandError` for an unknown
   * command, bad arguments, and a `needsView` command when the figure is not open.
   */
  run(figurePath: string, id: string, args?: unknown): Promise<unknown>;
  /** Runs the calls in order as one edit, all or nothing: one undo step in a view, one save headless. Resolves to their results. */
  batch(figurePath: string, calls: Call[]): Promise<unknown[]>;
  /** The figure's document as JSON: the open view's current one, else the file's. */
  read(figurePath: string): Promise<Document>;
  registries: Registries;
}

/** An open view of a figure, as the API uses it. */
export interface OpenFigure {
  store: DocumentStore;
  commandContext(): CommandContext;
}

/** What the API needs of the plugin, so that it can be tested without Obsidian. */
export interface ApiHost {
  app: App;
  registries: Registries;
  files: FigureFiles;
  /** The most recently active view that has the figure at `path` loaded, or null when none has. */
  openFigure(path: string): OpenFigure | null;
}

export function createApi(host: ApiHost): LinkFiguresApi {
  const { app, registries, files } = host;
  // Headless calls on one file run one after another, so a script that does not await each call loses no edit.
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(path: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(path) ?? Promise.resolve()).then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(path, settled);
    void settled.then(() => {
      if (queues.get(path) === settled) queues.delete(path);
    });
    return next;
  };

  const callsOf = (calls: unknown): Call[] => {
    if (!Array.isArray(calls)) throw new CommandError('a batch is an array of calls ({ id, args? })');
    return calls as Call[];
  };

  return {
    registries,

    commands: () =>
      registries.commands.all().map((c) => ({
        id: c.id,
        name: c.name,
        group: c.group,
        ...(c.params ? { params: structuredClone(c.params) } : {}),
        needsView: c.needsView === true,
      })),

    async run(figurePath, id, args) {
      const view = host.openFigure(figurePath);
      const call = prepareCall(registries, { id, args }, view === null);
      if (view) return runCall(view.store, view.commandContext(), call);
      return queued(figurePath, () => withHeadlessFigure(app, registries, files, figurePath, (ctx, store) => runCall(store, ctx, call)));
    },

    async batch(figurePath, calls) {
      const view = host.openFigure(figurePath);
      // Every call is checked before any runs, so a bad one changes nothing.
      const prepared = callsOf(calls).map((call) => prepareCall(registries, call, view === null));
      if (view) return runBatch(view.store, view.commandContext(), prepared);
      return queued(figurePath, () =>
        withHeadlessFigure(app, registries, files, figurePath, (ctx, store) => runBatch(store, ctx, prepared)),
      );
    },

    async read(figurePath) {
      const view = host.openFigure(figurePath);
      // A copy: the store's document is frozen, and what the caller does with it is not an edit.
      if (view) return structuredClone(view.store.doc);
      return queued(figurePath, () => withHeadlessFigure(app, registries, files, figurePath, (ctx) => structuredClone(ctx.store.doc)));
    },
  };
}
