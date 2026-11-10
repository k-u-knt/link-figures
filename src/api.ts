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
import { FILE_SUFFIX } from "./constants";
import type { ExportOutcome, ExportRequest } from "./export/export-run";
import { newFigureText } from "./format/new-figure";
import type { BlockIdResult } from "./links/note-block-id";
import { DEFAULT_PRESET_ID, getPreset } from "./model/presets";
import type { DocumentStore } from "./model/store";
import type { Document, Paint } from "./model/types";
import { paintOfRamp, rampOf, type ColorRamp } from "./paint/ramp";
import type { Registries } from "./registry";
import { settlesWithin } from "./util/event-loop";
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
  /**
   * Creates a new figure file at `path` (a vault path, normalised: an absolute path such as "/figs/a" is taken as
   * vault-relative, and a "." or ".." segment is refused; `.lnkfig.md` is appended when it does not end so), as the "New
   * figure" command makes one: `pages` empty pages (1 by default, up to 100) of the page preset `preset` (an id from
   * the presets list; the Default page preset setting when left out). The folders above it that are missing are
   * created. Refuses (`CommandError`) an unknown preset, a bad number of pages, and a path something is already at.
   * Resolves to the figure's vault path. Not a figure command: it makes the file the commands then act on.
   */
  createFigure(path: string, options?: CreateFigureOptions): Promise<{ path: string }>;
  /**
   * Colour as the inspector's colour slider edits it, so that scripts share its rule: `of` reads a paint whose type has
   * a ramp (solid, linear, radial) as a ramp of stops, sorted (undefined for one that has none); `toPaint` writes a ramp
   * back, one stop as a solid and more as the paint of its geometry, keeping `previous`'s other keys when it is of the
   * type written. Neither changes a figure: pass the paint to `node.update` with `replace` naming its top-level key.
   */
  ramp: {
    of(paint: Paint): ColorRamp | undefined;
    toPaint(ramp: ColorRamp, previous?: Paint): Paint;
  };
  registries: Registries;
}

/** What `api.createFigure` may be told about the new figure. */
export interface CreateFigureOptions {
  /** A page preset's id (see model/presets.ts); the Default page preset setting when left out. */
  preset?: string;
  /** How many pages it has, all of the preset (1 to `MAX_NEW_FIGURE_PAGES`); 1 when left out. */
  pages?: number;
}

/** The most pages `api.createFigure` makes a figure with. */
export const MAX_NEW_FIGURE_PAGES = 100;

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
  /**
   * Resolves once every view of the figure at `path` (normalised) that is still loading has finished (its first
   * `setViewData` done); null when none is loading. A call waits on it before it decides between a view and the file,
   * so a view that opens while a call works on the file takes over only for the calls after it, with that call's edit
   * loaded. Without it, a call decides at once.
   */
  loadingFigure?(path: string): Promise<void> | null;
  /** Finds or writes the block id at `line` of the note at `path` (normalised): see `noteBlockId`. Without it, `blockId` rejects. */
  noteBlockId?(path: string, line: number): Promise<BlockIdResult>;
  /** Exports the figure at `path` (normalised), opening it in the background when it is not open: see `exportFigure`. Without it, `export` rejects. */
  exportFigure?(path: string, request: ExportRequest): Promise<ExportOutcome>;
  /**
   * Writes `text` as a new file at `path` (normalised), creating the folders above it that are missing; rejects, writing
   * nothing, when something is already there (see `writeNewFigureFile`). Without it, `createFigure` rejects.
   */
  createFigureFile?(path: string, text: string): Promise<void>;
  /** The Default page preset setting; without it, `DEFAULT_PRESET_ID`. */
  defaultPreset?(): string;
  /** The Maximum page size setting, in mm, which headless page sizes keep to; without it, `DEFAULT_PAGE_LIMIT_MM`. */
  pageLimitMm?(): number;
}

/** How long an API call waits at most for a view of its figure that is still loading (see `ApiHost.loadingFigure`). */
export const LOADING_WAIT_MS = 5000;


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
    const start = async () => {
      // A view still loading decides nothing yet: the call waits for it, so it does not go to the file under the view's
      // feet, and then runs in it. Another may have started loading meanwhile, so this is asked again until none is.
      // The wait is bounded (`LOADING_WAIT_MS`): a view that never finishes loading holds no call up for good.
      const deadline = Date.now() + LOADING_WAIT_MS;
      for (let loading = host.loadingFigure?.(path); loading; loading = host.loadingFigure?.(path)) {
        const left = deadline - Date.now();
        if (left <= 0 || !(await settlesWithin(loading, left))) break;
      }
      return work(path, host.openFigure(path));
    };
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

  /** What a headless call is told of the settings (see `HeadlessOptions`). */
  const headless = () => ({ pageLimitMm: host.pageLimitMm?.() });

  return {
    registries,

    ramp: {
      of: (paint) => structuredClone(rampOf(paint, registries)),
      toPaint: (ramp, previous) => structuredClone(paintOfRamp(ramp, previous, registries.rampGeometries, registries.paints)),
    },

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
        return runHeadless(app, registries, files, path, call, headless());
      });
    },

    async batch(figurePath, calls) {
      // Every call is checked before any runs, so a bad one changes nothing.
      const prepared = prepareBatch(registries, calls);
      return queued(figurePath, (path, view) => {
        if (view) return runBatch(view.store, view.commandContext(), prepared);
        return withHeadlessFigure(app, registries, files, path, (ctx, store) => runBatch(store, ctx, prepared), headless());
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

    async createFigure(figurePath, options = {}) {
      const command = "createFigure";
      if (typeof figurePath !== "string" || figurePath.trim() === "") throw new CommandError(`${command}: the path must name a file in the vault`);
      if (typeof options !== "object" || options === null || Array.isArray(options)) throw new CommandError(`${command}: the options must be an object`);
      const { pages = 1 } = options;
      // A stale setting falls back to the default preset, as the New figure command does; a preset the caller names
      // (null included) must be one.
      const setting = host.defaultPreset?.();
      const preset: unknown = options.preset !== undefined ? options.preset : setting !== undefined && getPreset(setting) ? setting : DEFAULT_PRESET_ID;
      if (typeof preset !== "string" || !getPreset(preset)) throw new CommandError(`${command}: there is no page preset ${JSON.stringify(preset) ?? String(preset)}`);
      if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1 || pages > MAX_NEW_FIGURE_PAGES) {
        throw new CommandError(`${command}: "pages" must be a whole number from 1 to ${MAX_NEW_FIGURE_PAGES}`);
      }
      const write = host.createFigureFile;
      if (!write) throw new CommandError(`${command}: figures cannot be created here`);
      // Obsidian's normalizePath drops a leading "/" (so an absolute path is taken as vault-relative) but leaves "." and
      // "..", which would name a file outside the folder written, or outside the vault.
      const normalised = host.normalizePath(figurePath);
      if (normalised === "/" || normalised.split("/").some((part) => part === "." || part === "..")) {
        throw new CommandError(`${command}: the path must name a file in the vault`);
      }
      const path = normalised.endsWith(FILE_SUFFIX) ? normalised : `${normalised}${FILE_SUFFIX}`;
      // In the figure's queue, so a call on it made right after this one waits for the file to be there.
      return queued(path, async () => {
        await write(path, newFigureText(preset, pages));
        return { path };
      });
    },

    async read(figurePath) {
      // A copy: the store's document is frozen, and what the caller does with it is not an edit.
      return queued(figurePath, async (path, view) => structuredClone(view ? view.store.doc : await readHeadlessFigure(registries, files, path)));
    },
  };
}
