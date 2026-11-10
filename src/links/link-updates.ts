import type { App } from "obsidian";

/**
 * Obsidian's queue of link updates (`FileManager.updateQueue` and `inProgressUpdates`, not in its typings; as 1.15 has
 * them). A rename through `fileManager.renameFile` is one job of the queue: it waits for the metadata cache, collects
 * every link in the vault with its offsets in its file (as the cache has them then), renames, then (after the "Update
 * links" prompt, which may stay open for as long as the user likes) splices the new links into each file's text at
 * those offsets (`vault.process`), checking nothing. A write of such a file landing between the two (the figure view's
 * debounced save) leaves the offsets stale, and the splice then lands in the wrong places: Links entries overwritten,
 * the `## Figure` heading cut.
 */
interface LinkUpdateQueue {
  updateQueue?: { queue?: (job: () => Promise<unknown>) => Promise<unknown> };
  inProgressUpdates?: unknown[] | null;
}

/**
 * Runs `write`, a write of a vault file that may hold links (a figure file, a note), after every link update Obsidian
 * has under way or queued, as a job of its queue: no link update collects its offsets while the write is pending, nor
 * applies them after it landed. Inside a link update's own job (its rename is running: `inProgressUpdates`) the
 * write runs at once, as waiting for the queue there would wait for itself. Without the queue (another Obsidian), it
 * runs at once.
 */
export function afterLinkUpdates<T>(app: App, write: () => Promise<T>): Promise<T> {
  const manager = (app as { fileManager?: LinkUpdateQueue }).fileManager;
  const queue = manager?.updateQueue;
  if (!queue || typeof queue.queue !== "function" || (manager.inProgressUpdates ?? null) !== null) return write();
  let result: T;
  return queue.queue(async () => {
    result = await write();
  }).then(() => result);
}
