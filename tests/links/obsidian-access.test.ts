// @vitest-environment happy-dom
vi.mock("obsidian", () => ({ resolveSubpath: () => null }));

const { ObsidianVaultAccess } = await import("../../src/links/obsidian-access");

export {};

/** An app with one note whose stat is `stat`, and a metadata cache whose internals say it last read `cached`. */
function makeApp(stat: { mtime: number; size: number }, cached: { mtime: number; size: number; hash: string } | undefined) {
  const listeners: ((file: { path: string }) => void)[] = [];
  const file = { path: "Notes/a.md", extension: "md", stat };
  const metadataCache = {
    fileCache: cached ? { "Notes/a.md": cached } : {},
    metadataCache: { h1: {}, h2: {} } as Record<string, unknown>,
    on: (_name: string, fn: (file: { path: string }) => void) => (listeners.push(fn), fn),
    offref: (ref: unknown) => void listeners.splice(listeners.indexOf(ref as never), 1),
  };
  const fake = { vault: { getFileByPath: (p: string) => (p === file.path ? file : null) }, metadataCache };
  return { app: fake as never, changed: (path: string) => [...listeners].forEach((fn) => fn({ path })), listeners };
}

describe("ObsidianVaultAccess.settled", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("at once when the metadata cache was made from the note as it is now, or for a file that is not a note", async () => {
    const { app: a, listeners } = makeApp({ mtime: 5, size: 10 }, { mtime: 5, size: 10, hash: "h1" });
    const access = new ObsidianVaultAccess(a);
    await access.settled("Notes/a.md");
    await access.settled("Nowhere.md");
    expect(listeners).toHaveLength(0);
  });

  test("after a write, once the cache says the note changed; another note's change does not count", async () => {
    const { app: a, changed, listeners } = makeApp({ mtime: 6, size: 12 }, { mtime: 5, size: 10, hash: "h1" });
    const access = new ObsidianVaultAccess(a);
    let done = false;
    const settling = access.settled("Notes/a.md").then(() => (done = true));
    changed("Notes/other.md");
    await Promise.resolve();
    expect(done).toBe(false);
    changed("Notes/a.md");
    await settling;
    expect(listeners).toHaveLength(0);
  });

  test("bounded: it settles after the wait when the cache never says so", async () => {
    const { app: a, listeners } = makeApp({ mtime: 6, size: 12 }, undefined);
    const access = new ObsidianVaultAccess(a);
    let done = false;
    const settling = access.settled("Notes/a.md", 100).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settling;
    expect(listeners).toHaveLength(0);
  });
});
