import { InvalidationIndex } from "../../src/links/invalidation";
import { LinkWatcher } from "../../src/links/watcher";

vi.mock("obsidian", () => ({
  TFile: class {
    constructor(public path: string) {}
  },
}));

const { TFile } = await import("obsidian");
const file = (path: string) => new (TFile as unknown as new (path: string) => object)(path);
const folder = (path: string) => ({ path, children: [] });

type Handler = (...args: unknown[]) => void;

function setup(missing: string[] = []) {
  const handlers = new Map<string, Handler[]>();
  const on = (name: string, cb: Handler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), cb]);
    return { name, cb };
  };
  const app = { vault: { on }, metadataCache: { on } };
  const unload: (() => void)[] = [];
  const component = { registerEvent: vi.fn(), register: (fn: () => void) => void unload.push(fn) };
  const index = new InvalidationIndex();
  const calls: string[][] = [];
  const missingIds = vi.fn(() => missing);
  const watcher = new LinkWatcher(app as never, index, (ids) => void calls.push(ids.sort()), missingIds, 300);
  watcher.start(component as never);
  const emit = (name: string, ...args: unknown[]) => void handlers.get(name)?.forEach((cb) => cb(...args));
  return { index, calls, emit, missing, missingIds, unload, handlers, component };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a modified, deleted or renamed source", () => {
  test("invalidates the nodes that depend on it, once, after the debounce", () => {
    const t = setup();
    t.index.track("p-1", ["plot.png"]);
    t.index.track("p-2", ["plot.png", "a.md"]);
    t.index.track("p-3", ["other.png"]);
    t.emit("modify", file("plot.png"));
    t.emit("modify", file("plot.png"));
    vi.advanceTimersByTime(299);
    expect(t.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.calls).toEqual([["p-1", "p-2"]]);
    vi.advanceTimersByTime(1000);
    expect(t.calls).toHaveLength(1);
  });

  test("a file nothing depends on does nothing", () => {
    const t = setup();
    t.emit("modify", file("unrelated.md"));
    t.emit("delete", file("unrelated.md"));
    vi.advanceTimersByTime(1000);
    expect(t.calls).toEqual([]);
  });

  test("a rename moves the dependency to the new path and invalidates the node", () => {
    const t = setup();
    t.index.track("p-1", ["plot.png"]);
    t.emit("rename", file("plot2.png"), "plot.png");
    vi.advanceTimersByTime(300);
    expect(t.calls).toEqual([["p-1"]]);
    expect(t.index.nodesFor("plot2.png")).toEqual(["p-1"]);
    expect(t.index.nodesFor("plot.png")).toEqual([]);
  });

  test("a folder is not a file", () => {
    const t = setup(["p-9"]);
    t.index.track("p-1", ["plot.png"]);
    t.emit("modify", folder("plot.png"));
    t.emit("rename", folder("x"), "plot.png");
    vi.advanceTimersByTime(1000);
    expect(t.calls).toEqual([]);
    expect(t.index.nodesFor("plot.png")).toEqual(["p-1"]);
  });
});

describe("a file that is created", () => {
  test("invalidates the nodes that are missing, so a re-created file is picked up", () => {
    const t = setup(["p-4", "p-7"]);
    t.emit("create", file("plot.png"));
    expect(t.calls).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(t.calls).toEqual([["p-4", "p-7"]]);
  });

  test("asks the view which nodes are missing when the file appears, not when the watcher starts", () => {
    const t = setup(["p-4"]);
    t.missing.length = 0;
    t.missing.push("p-8");
    t.emit("create", file("plot.png"));
    vi.advanceTimersByTime(300);
    expect(t.calls).toEqual([["p-8"]]);
  });

  test("with no node missing there is nothing to do", () => {
    const t = setup([]);
    t.emit("create", file("plot.png"));
    vi.advanceTimersByTime(1000);
    expect(t.calls).toEqual([]);
  });

  test("a folder that is created is ignored", () => {
    const t = setup(["p-4"]);
    t.emit("create", folder("figs"));
    vi.advanceTimersByTime(1000);
    expect(t.calls).toEqual([]);
    expect(t.missingIds).not.toHaveBeenCalled();
  });

  test("a storm of creates is one flush with each node listed once, after it has gone quiet", () => {
    const t = setup(["p-4", "p-7"]);
    for (let i = 0; i < 500; i++) {
      t.emit("create", file(`incoming/${i}.md`));
      vi.advanceTimersByTime(100);
    }
    expect(t.calls).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(t.calls).toEqual([["p-4", "p-7"]]);
  });

  test("a rename into a name that a missing node is waiting for is picked up as well", () => {
    const t = setup(["p-4"]);
    t.emit("rename", file("plot.png"), "plot2.png");
    vi.advanceTimersByTime(300);
    expect(t.calls).toEqual([["p-4"]]);
  });

  test("a create and a modify of a source in one burst are one flush", () => {
    const t = setup(["p-4"]);
    t.index.track("p-1", ["plot.png"]);
    t.emit("create", file("plot.png"));
    t.emit("modify", file("plot.png"));
    vi.advanceTimersByTime(300);
    expect(t.calls).toEqual([["p-1", "p-4"]]);
  });
});

describe("unloading", () => {
  test("drops what is pending, and the timer with it", () => {
    const t = setup(["p-4"]);
    t.emit("create", file("plot.png"));
    for (const fn of t.unload) fn();
    vi.advanceTimersByTime(1000);
    expect(t.calls).toEqual([]);
  });

  test("subscribes to every event through the component, so unloading it removes them", () => {
    const t = setup();
    expect([...t.handlers.keys()].sort()).toEqual(["changed", "create", "delete", "modify", "rename"]);
    expect(t.component.registerEvent).toHaveBeenCalledTimes(5);
  });
});
