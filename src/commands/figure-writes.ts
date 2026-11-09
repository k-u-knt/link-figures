import type { FigureFiles } from "./headless";

/**
 * The writes of figure files that the plugin has in flight, by vault path: a view that starts to load a figure waits
 * for them (`settled`) before it reads the file, so it never takes up the text a write is about to replace.
 */
export class FigureWrites {
  private readonly pending = new Map<string, Set<Promise<unknown>>>();

  /** Records `write` as in flight on `path` until it settles, and gives it back. */
  track<T>(path: string, write: Promise<T>): Promise<T> {
    let set = this.pending.get(path);
    if (!set) this.pending.set(path, (set = new Set()));
    set.add(write);
    const done = () => {
      set.delete(write);
      if (set.size === 0 && this.pending.get(path) === set) this.pending.delete(path);
    };
    write.then(done, done);
    return write;
  }

  /** Resolves once every write on `path` in flight now has settled (whatever its outcome); null when there is none. */
  settled(path: string): Promise<void> | null {
    const set = this.pending.get(path);
    if (!set || set.size === 0) return null;
    return Promise.allSettled([...set]).then(() => undefined);
  }

  /** `files` with every `process` recorded here from the moment it is called. */
  wrap(files: FigureFiles): FigureFiles {
    return {
      read: (path) => files.read(path),
      process: (path, edit) => this.track(path, files.process(path, edit)),
    };
  }
}
