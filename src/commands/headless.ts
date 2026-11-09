import { current } from "immer";
import type { App } from "obsidian";
import { loadDocument } from "../format/load";
import type { ParsedFigureFile } from "../format/parse";
import { serializeFigureFile } from "../format/serialize";
import { createFigureStore } from "../model/normalise";
import type { DocumentStore } from "../model/store";
import type { Document, NodeId } from "../model/types";
import type { Registries } from "../registry";
import { CommandError, type Command, type CommandContext, type CommandStore, type UndoStep } from "../registry/command";
import { validateArgs } from "../registry/params";

/** One call of a command by id, with its JSON arguments. */
export interface Call {
  id: string;
  args?: unknown;
}

/** A call checked and ready to run: the command, and its validated arguments (undefined for a command without params). */
export interface PreparedCall {
  command: Command;
  args: Record<string, unknown> | undefined;
}

/**
 * Looks up the command of `call` and checks its arguments, before anything is changed. Throws `CommandError` for an
 * unknown command and for arguments that do not meet the command's params (the message names the parameter). A command
 * without params takes no arguments.
 */
export function prepareCall(registries: Registries, call: Call): PreparedCall {
  if (typeof call !== "object" || call === null || typeof call.id !== "string") {
    throw new CommandError('each call must be an object with a command "id" and optional "args"');
  }
  const command = registries.commands.get(call.id);
  if (!command) throw new CommandError(`there is no command "${call.id}"`);
  const checked = validateArgs(command.params ?? {}, call.args);
  if (!checked.ok) throw new CommandError(`${command.id}: ${checked.error}`);
  return { command, args: command.params ? checked.value : undefined };
}

/**
 * Prepares the calls of a batch, every one before any runs. A `needsView` command is refused: what it does (a zoom, a
 * dialog, a tool) is not an edit of the document, so it would not be undone with a batch that fails.
 */
export function prepareBatch(registries: Registries, calls: unknown): PreparedCall[] {
  if (!Array.isArray(calls)) throw new CommandError("a batch is an array of calls ({ id, args? })");
  return calls.map((call: Call) => {
    const prepared = prepareCall(registries, call);
    if (prepared.command.needsView) throw new CommandError(`${prepared.command.id} cannot run in a batch`);
    return prepared;
  });
}

/** Refuses a `needsView` call when there is no view: `CommandError("<id> needs the figure to be open")`. */
export function requireView(call: PreparedCall, hasView: boolean): void {
  if (!hasView && call.command.needsView) throw new CommandError(`${call.command.id} needs the figure to be open`);
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

/**
 * Runs one prepared call to its end at once; its JSON result, null when it returns nothing. A command that does not
 * finish at once is refused (`why` says where it was run), and what it does later is not reported as unhandled.
 */
function runNow(ctx: CommandContext, { command, args }: PreparedCall, why: string): unknown {
  const result = command.run(ctx, args);
  if (isThenable(result)) {
    result.then(undefined, () => undefined);
    throw new CommandError(`${command.id} cannot run ${why}: it does not finish at once`);
  }
  return result ?? null;
}

/**
 * Runs one prepared call on an open view's `store` (the store of `ctx`); its JSON result, null when it returns nothing.
 * By default (`step` "own") its edit is an undo step of its own: it neither merges into the edit before it nor takes in
 * the one after. A gesture made of many calls (a drag) starts its step with "start", which may take in the calls that
 * follow, and goes on with "continue", which may merge into the step before (see `UndoStep`).
 */
export async function runCall(store: DocumentStore, ctx: CommandContext, call: PreparedCall, step: UndoStep = "own"): Promise<unknown> {
  if (step !== "continue") store.endMerge();
  try {
    return (await call.command.run(ctx, call.args)) ?? null;
  } finally {
    if (step === "own") store.endMerge();
  }
}

/**
 * The store that the commands of a batch edit through: every commit applies its recipe to the batch's one draft and
 * brings the draft in line with the store's normalisers, against the draft as it was before that commit, so each call
 * sees what the calls before it did and is normalised exactly as it would be on its own. History is the real store's,
 * after the batch: undo and redo cannot run inside one.
 */
class DraftStore implements CommandStore {
  private snapshot: Document | null = null;

  constructor(private readonly draft: Document, private readonly store: DocumentStore) {}

  get doc(): Document {
    this.snapshot ??= current(this.draft);
    return this.snapshot;
  }

  commit(_label: string, recipe: (draft: Document) => void): void {
    const before = this.doc;
    this.snapshot = null;
    recipe(this.draft);
    this.store.normalise(this.draft, before);
  }

  canUndo(): boolean {
    return false;
  }

  canRedo(): boolean {
    return false;
  }

  undo(): boolean {
    throw new CommandError("undo cannot run inside a batch");
  }

  redo(): boolean {
    throw new CommandError("redo cannot run inside a batch");
  }
}

/**
 * Runs `calls` (from `prepareBatch`) in order against one draft of `store`'s document inside one commit labelled
 * "batch": all of them or none. The first call that throws, or that does not finish at once (a command that awaits
 * cannot share a draft), aborts the batch, and the document and history are left exactly as they were. Otherwise the
 * batch is one undo step, what the calls left to do after it (`afterCommit`) is done, and the results are the calls'
 * JSON results in order. `ctx` is the context each call gets, with `store` swapped for the draft.
 */
export function runBatch(store: DocumentStore, ctx: CommandContext, calls: readonly PreparedCall[]): unknown[] {
  // A batch is one undo step: it neither merges into the edit before it nor takes in the one after.
  store.endMerge();
  try {
    return runInOneCommit(store, ctx, calls, "batch");
  } finally {
    store.endMerge();
  }
}

/**
 * Runs `calls` as `runBatch` does, all or nothing, as one commit labelled `label` that, unlike a batch, merges with the
 * commits of the same label just before it as any commit does. For the UI's own runs of edits (the inspector's
 * `inspect:<key>` writes, which may change several nodes at once and merge while a colour is dragged).
 */
export function runInOneCommit(store: DocumentStore, ctx: CommandContext, calls: readonly PreparedCall[], label: string): unknown[] {
  let results: unknown[] = [];
  const pending: (() => void)[] = [];
  store.commit(label, (draft) => {
    pending.length = 0;
    const scoped: CommandContext = { ...ctx, store: new DraftStore(draft, store), afterCommit: (fn) => pending.push(fn) };
    results = calls.map((call) => runNow(scoped, call, "in a batch"));
  });
  for (const fn of pending) fn();
  return results;
}

/** Reading and changing a figure file's text by its vault path. */
export interface FigureFiles {
  /** Rejects when there is no file at `path`. */
  read(path: string): Promise<string>;
  /**
   * Reads the file, passes its text to `edit` and writes what `edit` returns, as one step that no other write comes
   * between (Obsidian's `vault.process`). Rejects, writing nothing, when there is no file or `edit` throws.
   */
  process(path: string, edit: (text: string) => string): Promise<void>;
}

/** A figure file's text loaded into a store with a figure's normalisers, and what loading it gave. */
function loadFigure(text: string, registries: Registries): { store: DocumentStore; parsed: ParsedFigureFile; unreadable: ReadonlySet<NodeId> } {
  const { doc, parsed, unreadable } = loadDocument(text, registries);
  return { store: createFigureStore(doc, registries), parsed, unreadable };
}

/** The document of the figure file at `path`, as a view would load it. */
export async function readHeadlessFigure(registries: Registries, files: FigureFiles, path: string): Promise<Document> {
  return loadFigure(await files.read(path), registries).store.doc;
}

/** What a headless call is told of the plugin's settings, which a view would otherwise give its commands. */
export interface HeadlessOptions {
  /** The Maximum page size setting, in mm (see `CommandContext.pageLimitMm`). */
  pageLimitMm?: number;
}

/** Runs one prepared call headless: see `withHeadlessFigure`. */
export function runHeadless(app: App, registries: Registries, files: FigureFiles, path: string, call: PreparedCall, options: HeadlessOptions = {}): Promise<unknown> {
  return withHeadlessFigure(app, registries, files, path, (ctx) => runNow(ctx, call, "when the figure is not open"), options);
}

/**
 * Applies `apply` to the figure at `path` without a view, in one atomic read-and-write of the file: the text is loaded
 * into a store with a figure's normalisers (no history is kept), handed to `apply` in a headless context (no view, no
 * selection, no page), and the file gets the document back when it changed, else its text as it was. A file that
 * cannot be read as a figure, or an `apply` that throws, rejects and changes nothing.
 */
export async function withHeadlessFigure<T>(
  app: App,
  registries: Registries,
  files: FigureFiles,
  path: string,
  apply: (ctx: CommandContext, store: DocumentStore) => T,
  options: HeadlessOptions = {},
): Promise<T> {
  let result: T | undefined;
  await files.process(path, (text) => {
    const loadedFigure = loadFigure(text, registries);
    const { store, parsed } = loadedFigure;
    // The nodes their plugin could not read, as a view holds them: no hook of their type is called on them, and a
    // duplicate adds its copies of them for the calls after it.
    const unreadable = new Set(loadedFigure.unreadable);
    // After the normalisers, so a file that only they would change is not rewritten when the call changes nothing.
    const loaded = store.doc;
    const ctx: CommandContext = {
      app,
      registries,
      view: null,
      store,
      selection: [],
      page: undefined,
      unreadable,
      markUnreadable: (ids) => ids.forEach((id) => unreadable.add(id)),
      ...(options.pageLimitMm !== undefined ? { pageLimitMm: options.pageLimitMm } : {}),
    };
    result = apply(ctx, store);
    return store.doc === loaded ? text : serializeFigureFile(store.doc, parsed);
  });
  return result as T;
}
