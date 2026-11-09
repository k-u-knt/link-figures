import type { App } from "obsidian";
import {
  prepareBatch,
  prepareCall,
  readHeadlessFigure,
  requireView,
  runBatch,
  runCall,
  runHeadless,
  withHeadlessFigure,
  type Call,
  type FigureFiles,
} from "./commands/headless";
import type { ExportOutcome, ExportRequest } from "./export/export-run";
import type { BlockIdResult } from "./links/note-block-id";
import type { DocumentStore } from "./model/store";
import type { Document } from "./model/types";
import type { Registries } from "./registry";
import type { CommandContext } from "./registry/command";
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
  /**
   * The block id of the block that holds `line` (0-based) of the note at `notePath` (with or without `.md`), for
   * linking a panel to it (`subpath`, `#^id`): the id it has, or a new one (`<prefix>-<4 base36>`, the prefix from the
   * settings) written into the note, through its editor when it is open (so it can be undone there), else into the file.
   * Never writes when the block has an id. Rejects for a line in no block, a heading line (link it by its heading), and a
   * note that is not there. Not a figure command: it acts on a note, and finishes later. Calls on one note run one after
   * another, and one that wrote waits (up to 2 s) for the metadata cache to index its write before the next runs, so a
   * script may call it several times in a row. It writes whatever the `dropFromNote` setting is.
   */
  blockId(notePath: string, line: number): Promise<BlockIdResult>;
  /**
   * Exports the figure as the export modal does, to the export folder: `format` is an exporter's id (`svg`, `pdf`, `png`,
   * `tiff`), `pages` the page in focus (`"current"`, the default), `"all"` or a list of page ids, `dpi` the resolution
   * (the settings' when left out), `options` the exporter's own (each left out has its default). A figure that is not
   * open is opened in the background for it, once the request has been checked (a bad one opens nothing), waited on
   * until its links are resolved and its content cards drawn, and closed again. Resolves to the vault paths written and
   * the export report. Not a figure command: it finishes later. Waits for the calls queued on the figure before it.
   */
  export(figurePath: string, request: ExportRequest): Promise<ExportOutcome>;
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
  /** A vault path in the one form Obsidian keeps it in (Obsidian's `normalizePath`). */
  normalizePath(path: string): string;
  /** The most recently active view that has the figure at `path` (normalised) loaded, or null when none has. */
  openFigure(path: string): OpenFigure | null;
  /** Finds or writes the block id at `line` of the note at `path` (normalised): see `noteBlockId`. Without it, `blockId` rejects. */
  noteBlockId?(path: string, line: number): Promise<BlockIdResult>;
  /** Exports the figure at `path` (normalised), opening it in the background when it is not open: see `exportFigure`. Without it, `export` rejects. */
  exportFigure?(path: string, request: ExportRequest): Promise<ExportOutcome>;
}

export function createApi(host: ApiHost): LinkFiguresApi {
  const { app, registries, files } = host;
  /**
   * The work on each figure runs one call after another, so a script that does not await each call loses no edit. A
   * call decides between the open view and the file when its turn comes, so one queued while the figure was closed
   * acts on the view that has opened it since.
   */
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(figurePath: string, work: (path: string, view: OpenFigure | null) => T | Promise<T>): Promise<T> => {
    const path = host.normalizePath(figurePath);
    const start = () => work(path, host.openFigure(path));
    const next = (queues.get(path) ?? Promise.resolve()).then(start, start);
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
      const call = prepareCall(registries, { id, args });
      return queued(figurePath, (path, view) => {
        requireView(call, view !== null);
        if (view) return runCall(view.store, view.commandContext(), call);
        return runHeadless(app, registries, files, path, call);
      });
    },

    async batch(figurePath, calls) {
      // Every call is checked before any runs, so a bad one changes nothing.
      const prepared = prepareBatch(registries, calls);
      return queued(figurePath, (path, view) => {
        if (view) return runBatch(view.store, view.commandContext(), prepared);
        return withHeadlessFigure(app, registries, files, path, (ctx, store) => runBatch(store, ctx, prepared));
      });
    },

    async blockId(notePath, line) {
      if (!host.noteBlockId) throw new Error("blockId: notes cannot be written here");
      return host.noteBlockId(host.normalizePath(notePath), line);
    },

    async export(figurePath, request) {
      if (typeof request !== "object" || request === null || typeof request.format !== "string" || request.format === "") {
        throw new Error("export: format must be the id of an export format");
      }
      const exportFigure = host.exportFigure;
      if (!exportFigure) throw new Error("export: figures cannot be exported here");
      return queued(figurePath, (path) => exportFigure(path, request));
    },

    async read(figurePath) {
      // A copy: the store's document is frozen, and what the caller does with it is not an edit.
      return queued(figurePath, async (path, view) => structuredClone(view ? view.store.doc : await readHeadlessFigure(registries, files, path)));
    },
  };
}
