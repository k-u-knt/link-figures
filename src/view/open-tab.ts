import type { OpenViewState, TFile, Workspace, WorkspaceLeaf } from "obsidian";

/** What `focusOpenTab` uses of Obsidian's workspace. */
type TabWorkspace = Pick<Workspace, "iterateAllLeaves" | "setActiveLeaf">;

/**
 * Focuses a tab that already shows `file` in a Markdown view (the first one found), and takes it to `subpath` (`""`: the
 * note where it is); false, and nothing touched, when no tab shows it. As a click on a note card's label: the note's
 * tab is brought forward rather than a second one opened.
 */
export function focusOpenTab(workspace: TabWorkspace, file: TFile, subpath: string): boolean {
  let found: WorkspaceLeaf | null = null;
  workspace.iterateAllLeaves((leaf) => {
    if (found) return;
    const view = leaf.view as { file?: unknown; getViewType?(): string } | undefined;
    if (view?.file === file && view.getViewType?.() === "markdown") found = leaf;
  });
  const leaf = found as WorkspaceLeaf | null;
  if (!leaf) return false;
  workspace.setActiveLeaf(leaf, { focus: true });
  // A whole note stays where its tab has it; a section is scrolled to.
  if (subpath !== "") void leaf.openFile(file, { active: true, eState: { subpath } } satisfies OpenViewState);
  return true;
}
