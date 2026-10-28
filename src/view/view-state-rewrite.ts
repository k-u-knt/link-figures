import { around } from "monkey-around";
import { WorkspaceLeaf, type ViewState } from "obsidian";
import { VIEW_TYPE } from "../constants";
import type LinkFiguresPlugin from "../main";
import { isFigureFile } from "./open-hook";

/**
 * The state that opens a figure file in the figure view instead of the markdown view. Obsidian asks for the markdown view
 * for every `.md` file; this turns that request into the figure view's before Obsidian records it, so a figure opens in one
 * step and the navigation history holds one entry per open. The markdown-only state (`mode`, `source`) is dropped, while
 * `active`, `pinned` and `group` stay. Any other state is returned as it is.
 */
export function rewriteViewState(state: ViewState, isFigure: (path: string) => boolean): ViewState {
  const file = state.state?.file;
  if (state.type !== "markdown" || typeof file !== "string" || !isFigure(file)) return state;
  return { ...state, type: VIEW_TYPE, state: { file } };
}

/**
 * Wraps `setViewState` on the leaf prototype so a markdown open of a figure file goes to the figure view in one step.
 * The file-open hook stays as the fallback for an open that never reaches `setViewState` with a figure path. Returns the
 * function that removes the wrapper.
 */
export function installViewStateRewrite(
  plugin: LinkFiguresPlugin,
  prototype: Pick<WorkspaceLeaf, "setViewState"> = WorkspaceLeaf.prototype,
): () => void {
  const isFigure = (path: string): boolean => isFigureFile(plugin, path);
  return around(prototype, {
    setViewState: (next) =>
      function (this: WorkspaceLeaf, state: ViewState, ...rest: [eState?: unknown]) {
        return next.call(this, rewriteViewState(state, isFigure), ...rest);
      },
  });
}
