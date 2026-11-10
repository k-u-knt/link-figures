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

/** How `afterLinkUpdates` treats a write asked for from inside a link update's own job. */
export interface AfterLinkUpdatesOptions {
  /**
   * Queue it even then (after that job), rather than run it at once: for what the job never waits on, such as the
   * figure view's save, which must not land between the job's collecting its offsets and applying them.
   */
  alwaysQueue?: boolean;
}

/**
 * Runs `write`, a write of a vault file that may hold links (a figure file, a note), after every link update Obsidian
 * has under way or queued, as a job of its queue: no link update collects its offsets while the write is pending, nor
 * applies them after it landed. Inside a link update's own job (its rename is running: `inProgressUpdates`) the
 * write runs at once, as a write that the job itself waits on (an API call made from a plugin's rename callback) would
 * otherwise wait for itself; with `alwaysQueue` it is queued after that job. Without the queue (another Obsidian), it
 * runs at once.
 */
export function afterLinkUpdates<T>(app: App, write: () => Promise<T>, options: AfterLinkUpdatesOptions = {}): Promise<T> {
  const manager = (app as { fileManager?: LinkUpdateQueue }).fileManager;
  const queue = manager?.updateQueue;
  if (!queue || typeof queue.queue !== "function") return write();
  if (!options.alwaysQueue && (manager.inProgressUpdates ?? null) !== null) return write();
  let result: T;
  // Whatever the queue gives back, a promise is made of it.
  return Promise.resolve(
    queue.queue(async () => {
      result = await write();
    }),
  ).then(() => result);
}

/** Whether Obsidian has a queue of link updates that `afterLinkUpdates` can wait on (and so tell when one has ended). */
export function hasLinkUpdateQueue(app: App): boolean {
  return typeof (app as { fileManager?: LinkUpdateQueue }).fileManager?.updateQueue?.queue === "function";
}
