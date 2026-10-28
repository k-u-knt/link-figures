import type { ViewState } from "obsidian";
import { VIEW_TYPE } from "../../src/constants";

// `obsidian` ships only typings, so the modules under test get a stand-in for the few classes they name.
vi.mock("obsidian", () => ({ WorkspaceLeaf: class { setViewState() {} }, MarkdownView: class {}, Notice: class {} }));
const { rewriteViewState, installViewStateRewrite } = await import("../../src/view/view-state-rewrite");
const { isFigureFile } = await import("../../src/view/open-hook");

/** A stand-in for the plugin with the settings, the forced-markdown set and the parts of `app` that `isFigureFile` reads. */
const fakePlugin = (over: { openAsFigure?: boolean; forced?: string[]; cache?: Record<string, Record<string, unknown>> } = {}) => ({
  settings: { openAsFigure: over.openAsFigure ?? true },
  forcedMarkdown: new Set<string>(over.forced ?? []),
  app: {
    vault: { getFileByPath: (path: string) => (over.cache && path in over.cache ? { path } : null) },
    metadataCache: { getFileCache: (file: { path: string }) => ({ frontmatter: over.cache?.[file.path] }) },
  },
});

test("a markdown state for a figure file becomes the figure view's, keeping active/pinned/group", () => {
  const state = { type: "markdown", state: { file: "Notes/fig.lnkfig.md", mode: "source" }, active: true, pinned: true };
  expect(rewriteViewState(state, (p) => p.endsWith(".lnkfig.md"))).toEqual({
    type: VIEW_TYPE,
    state: { file: "Notes/fig.lnkfig.md" },
    active: true,
    pinned: true,
  });
});

test("the group of the state is kept as well", () => {
  const state = { type: "markdown", state: { file: "fig.lnkfig.md", source: true }, group: { id: "g" } as never };
  const rewritten = rewriteViewState(state, () => true);
  expect(rewritten.group).toBe(state.group);
  expect(rewritten.state).toEqual({ file: "fig.lnkfig.md" });
});

test("any other state is returned as it is", () => {
  const isFigure = (p: string) => p.endsWith(".lnkfig.md");
  for (const state of [
    { type: "markdown", state: { file: "note.md" } },
    { type: VIEW_TYPE, state: { file: "fig.lnkfig.md" } },
    { type: "markdown", state: {} },
    { type: "markdown", state: { file: 3 } },
    { type: "markdown" },
    { type: "empty" },
  ]) expect(rewriteViewState(state as never, isFigure)).toBe(state);
});

test("a markdown state is not rewritten when isFigure says no, and isFigure is asked about the file's path", () => {
  const asked: string[] = [];
  const state = { type: "markdown", state: { file: "Notes/fig.lnkfig.md" } };
  expect(rewriteViewState(state, (p) => (asked.push(p), false))).toBe(state);
  expect(asked).toEqual(["Notes/fig.lnkfig.md"]);
});

test("isFigureFile: the suffix decides without the cache; the setting off or a forced-markdown path says no", () => {
  expect(isFigureFile(fakePlugin() as never, "Notes/fig.lnkfig.md")).toBe(true);
  expect(isFigureFile(fakePlugin({ openAsFigure: false }) as never, "Notes/fig.lnkfig.md")).toBe(false);
  expect(isFigureFile(fakePlugin({ forced: ["Notes/fig.lnkfig.md"] }) as never, "Notes/fig.lnkfig.md")).toBe(false);
  expect(isFigureFile(fakePlugin() as never, "Notes/note.md")).toBe(false);
});

test("isFigureFile: a file without the suffix is a figure when its frontmatter carries the marker", () => {
  const plugin = fakePlugin({ cache: { "Notes/marked.md": { "link-figures": 1 }, "Notes/plain.md": { tags: ["a"] } } }) as never;
  expect(isFigureFile(plugin, "Notes/marked.md")).toBe(true);
  expect(isFigureFile(plugin, "Notes/plain.md")).toBe(false);
  expect(isFigureFile(plugin, "Notes/not-in-the-vault.md")).toBe(false);
  expect(isFigureFile(fakePlugin({ openAsFigure: false, cache: { "Notes/marked.md": { "link-figures": 1 } } }) as never, "Notes/marked.md")).toBe(false);
  expect(isFigureFile(fakePlugin({ forced: ["Notes/marked.md"], cache: { "Notes/marked.md": { "link-figures": 1 } } }) as never, "Notes/marked.md")).toBe(false);
});

test("installed on a leaf prototype, opening a figure from a note records one entry per open, so Back reaches the note", async () => {
  class Leaf {
    history: ViewState[] = [];
    async setViewState(state: ViewState) {
      this.history.push(state);
    }
  }
  const uninstall = installViewStateRewrite(fakePlugin() as never, Leaf.prototype);
  const leaf = new Leaf();
  await leaf.setViewState({ type: "markdown", state: { file: "note.md" } });
  await leaf.setViewState({ type: "markdown", state: { file: "fig.lnkfig.md" } });
  expect(leaf.history.map((s) => `${s.type}:${s.state?.file}`)).toEqual(["markdown:note.md", "link-figures:fig.lnkfig.md"]);
  await leaf.setViewState(leaf.history[0]); // what Back replays
  expect(leaf.history[2].type).toBe("markdown");
  uninstall();
  await leaf.setViewState({ type: "markdown", state: { file: "fig.lnkfig.md" } });
  expect(leaf.history[3].type).toBe("markdown");
});

test("the wrapper passes `this`, the other arguments and the result of the original through", async () => {
  class Leaf {
    seen: unknown[] = [];
    async setViewState(state: ViewState, eState?: unknown) {
      this.seen.push(this, state, eState);
      return "done" as never;
    }
  }
  const uninstall = installViewStateRewrite(fakePlugin() as never, Leaf.prototype);
  const leaf = new Leaf();
  const eState = { focus: true };
  await expect(leaf.setViewState({ type: "markdown", state: { file: "fig.lnkfig.md" } }, eState)).resolves.toBe("done");
  expect(leaf.seen).toEqual([leaf, { type: VIEW_TYPE, state: { file: "fig.lnkfig.md" } }, eState]);
  expect(leaf.seen[2]).toBe(eState);
  uninstall();
});

test("the setting is read at each call, so turning it off stops the rewriting without reinstalling", async () => {
  class Leaf {
    history: ViewState[] = [];
    async setViewState(state: ViewState) {
      this.history.push(state);
    }
  }
  const plugin = fakePlugin();
  const uninstall = installViewStateRewrite(plugin as never, Leaf.prototype);
  const leaf = new Leaf();
  plugin.settings.openAsFigure = false;
  await leaf.setViewState({ type: "markdown", state: { file: "fig.lnkfig.md" } });
  plugin.forcedMarkdown.add("other.lnkfig.md");
  await leaf.setViewState({ type: "markdown", state: { file: "other.lnkfig.md" } });
  plugin.settings.openAsFigure = true;
  await leaf.setViewState({ type: "markdown", state: { file: "fig.lnkfig.md" } });
  expect(leaf.history.map((s) => `${s.type}:${s.state?.file}`)).toEqual([
    "markdown:fig.lnkfig.md",
    "markdown:other.lnkfig.md",
    "link-figures:fig.lnkfig.md",
  ]);
  uninstall();
});
