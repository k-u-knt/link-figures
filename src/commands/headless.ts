import { current } from "immer";
import type { App } from "obsidian";
import { loadDocument } from "../format/load";
import { serializeFigureFile } from "../format/serialize";
import { createFigureStore } from "../model/normalise";
import type { DocumentStore } from "../model/store";
import type { Document } from "../model/types";
import type { Registries } from "../registry";
import { CommandError, type Command, type CommandContext, type CommandStore } from "../registry/command";
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
 * unknown command, for a `needsView` command when `headless`, and for arguments that do not meet the command's params
 * (the message names the parameter). A command without params takes no arguments.
 */
export function prepareCall(registries: Registries, call: Call, headless: boolean): PreparedCall {
  if (typeof call !== "object" || call === null || typeof call.id !== "string") {
    throw new CommandError('each call must be an object with a command "id" and optional "args"');
  }
  const command = registries.commands.get(call.id);
  if (!command) throw new CommandError(`there is no command "${call.id}"`);
  if (headless && command.needsView) throw new CommandError(`${command.id} needs the figure to be open`);
  const checked = validateArgs(command.params ?? {}, call.args);
  if (!checked.ok) throw new CommandError(`${command.id}: ${checked.error}`);
  return { command, args: command.params ? checked.value : undefined };
}

/**
 * Runs one prepared call on `store` (the store of `ctx`); what it returns is its JSON result, null when it returns
 * nothing. Its edit is an undo step of its own: it neither merges into the edit before it nor takes in the one after.
 */
export async function runCall(store: DocumentStore, ctx: CommandContext, call: PreparedCall): Promise<unknown> {
  store.endMerge();
  try {
    return (await call.command.run(ctx, call.args)) ?? null;
  } finally {
    store.endMerge();
  }
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

/**
 * The store that the commands of a batch edit through: every commit applies its recipe to the batch's one draft and
 * brings the draft in line with the store's normalisers, so each call sees what the calls before it did. History is the
 * real store's, after the batch: undo and redo cannot run inside one.
 */
class DraftStore implements CommandStore {
  private snapshot: Document | null = null;

  constructor(private readonly draft: Document, private readonly store: DocumentStore) {}

  get doc(): Document {
    this.snapshot ??= current(this.draft);
    return this.snapshot;
  }

  commit(_label: string, recipe: (draft: Document) => void): void {
    this.snapshot = null;
    recipe(this.draft);
    this.store.normalise(this.draft);
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
 * Runs `calls` in order against one draft of `store`'s document inside one commit labelled "batch": all of them or none.
 * The first call that throws, or that does not finish at once (a command that awaits cannot share a draft), aborts the
 * batch, and the document and history are left exactly as they were. Otherwise the batch is one undo step, and the
 * results are the calls' JSON results in order. `ctx` is the context each call gets, with `store` swapped for the draft.
 */
export function runBatch(store: DocumentStore, ctx: CommandContext, calls: readonly PreparedCall[]): unknown[] {
  let results: unknown[] = [];
  // A batch is one undo step: it neither merges into the edit before it nor takes in the one after.
  store.endMerge();
  store.commit("batch", (draft) => {
    const scoped: CommandContext = { ...ctx, store: new DraftStore(draft, store) };
    results = calls.map(({ command, args }) => {
      const result = command.run(scoped, args);
      if (isThenable(result)) {
        // Whatever it does later is not part of the batch; its outcome is not to be reported as unhandled.
        result.then(undefined, () => undefined);
        throw new CommandError(`${command.id} cannot run in a batch: it does not finish at once`);
      }
      return result ?? null;
    });
  });
  store.endMerge();
  return results;
}

/** Reading and writing a figure file's text by its vault path. */
export interface FigureFiles {
  /** Rejects when there is no file at `path`. */
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

/**
 * Applies `apply` to the figure at `path` without a view: the file is read, loaded into a store with a figure's
 * normalisers (no history is kept), handed to `apply` in a headless context (no view, no selection, no page), and
 * written back when the document changed. A file that cannot be read as a figure rejects, and is not written.
 */
export async function withHeadlessFigure<T>(
  app: App,
  registries: Registries,
  files: FigureFiles,
  path: string,
  apply: (ctx: CommandContext, store: DocumentStore) => T | Promise<T>,
): Promise<T> {
  const { doc, parsed } = loadDocument(await files.read(path));
  const store = createFigureStore(doc, registries);
  // After the normalisers, so a file that only they would change is not rewritten when the call changes nothing.
  const loaded = store.doc;
  const ctx: CommandContext = { app, registries, view: null, store, selection: [], page: undefined };
  const result = await apply(ctx, store);
  if (store.doc !== loaded) await files.write(path, serializeFigureFile(store.doc, parsed));
  return result;
}
