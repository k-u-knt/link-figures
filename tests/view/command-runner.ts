import { drawingCommands } from "../../src/commands/drawing";
import { prepareCall, runCall } from "../../src/commands/headless";
import type { DocumentStore } from "../../src/model/store";
import { createRegistries, type Registries } from "../../src/registry";
import type { CommandContext, UndoStep } from "../../src/registry/command";
import type { SelectionState } from "../../src/view/selection";

/** Registries with the drawing commands (`node.move` among them), for a fake view that runs the commands the pointer runs. */
export function registriesWithDrawing(): Registries {
  const registries = createRegistries();
  for (const command of drawingCommands()) registries.commands.register(command);
  return registries;
}

/**
 * What the figure view's `runCommandById(id, args, step)` does with args: the call checked and run as the API runs it on
 * an open figure, on the fake view's store and selection. The edit is in by the time it returns.
 */
export function runCommandWith(registries: Registries, view: { store: DocumentStore; selection: SelectionState }) {
  return (id: string, args?: Record<string, unknown>, step?: UndoStep): void => {
    if (args === undefined) return;
    const ctx: CommandContext = { app: {} as never, registries, view: null, store: view.store, selection: [...view.selection.ids], page: view.store.doc.pages[0] };
    void runCall(view.store, ctx, prepareCall(registries, { id, args }), step);
  };
}
