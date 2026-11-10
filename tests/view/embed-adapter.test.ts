// @vitest-environment happy-dom
import { noteFile, openEmbed } from "../../src/view/embed-adapter";
import { fakeEmbedRegistry, type FakeEmbed } from "../support/fake-embed";

const file = { path: "Notes/a.md", extension: "md", basename: "a" };

function container(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

afterEach(() => vi.restoreAllMocks());

describe("openEmbed", () => {
  test("calls getEmbedCreator(file)(ctx, file, subpath) as ya.load does, then sets editable, useIframe and requestEdit, loads and reads the note", async () => {
    const { registry, embeds } = fakeEmbedRegistry();
    const getEmbedCreator = vi.spyOn(registry, "getEmbedCreator");
    const app = { embedRegistry: registry };
    const el = container();
    const live = openEmbed(app as never, file as never, "#Legend", el, "fig.lnkfig.md");
    expect(live).not.toBeNull();
    expect(getEmbedCreator).toHaveBeenCalledWith(file);
    const [embed] = embeds;
    expect(embed.ctx).toEqual({ app, linktext: "Notes/a.md#Legend", sourcePath: "fig.lnkfig.md", containerEl: expect.any(HTMLElement), depth: 0 });
    expect(embed.ctx.containerEl.parentElement).toBe(el);
    expect(embed.file).toBe(file);
    expect(embed.subpath).toBe("#Legend");
    expect(embed.editable).toBe(true);
    expect(embed.useIframe).toBe(true);
    expect(typeof embed.requestEdit).toBe("function");
    await live!.ready;
    expect(embed.calls).toEqual(["load", "loadFile"]);
  });

  test("edit opens the editor at the point, converted by the embed itself; stopEditing saves and goes back to the preview", () => {
    const { registry, embeds } = fakeEmbedRegistry();
    const changes: boolean[] = [];
    const live = openEmbed({ embedRegistry: registry } as never, file as never, "", container(), "fig.lnkfig.md", { onEditingChange: (e) => changes.push(e) })!;
    const embed = embeds[0] as FakeEmbed;
    expect(live.editing()).toBe(false);
    live.edit({ x: 10, y: 20 });
    expect(embed.editorCalls).toEqual([{ x: 10, y: 20 }]);
    expect(live.editing()).toBe(true);
    expect(changes).toEqual([true]);
    embed.type("new text");
    live.stopEditing();
    expect(embed.writes).toEqual(["new text"]);
    expect(live.editing()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("the embed ending its own edit (Escape) is told; requestEdit edits, unless canEdit says no", () => {
    const { registry, embeds } = fakeEmbedRegistry();
    const changes: boolean[] = [];
    let can = false;
    const live = openEmbed({ embedRegistry: registry } as never, file as never, "", container(), "f", { onEditingChange: (e) => changes.push(e), canEdit: () => can })!;
    const embed = embeds[0];
    embed.requestEdit!();
    expect(live.editing()).toBe(false);
    live.edit();
    expect(live.editing()).toBe(false);
    can = true;
    embed.requestEdit!();
    expect(live.editing()).toBe(true);
    embed.showPreview(true);
    expect(changes).toEqual([true, false]);
  });

  test("flush writes a queued save now; unload ends an edit with a save first", async () => {
    const { registry, embeds } = fakeEmbedRegistry();
    const live = openEmbed({ embedRegistry: registry } as never, file as never, "", container(), "f")!;
    const embed = embeds[0];
    live.edit();
    embed.type("typed");
    await live.flush();
    expect(embed.writes).toEqual(["typed"]);
    // Nothing queued: nothing written.
    await live.flush();
    expect(embed.writes).toEqual(["typed"]);
    embed.type("more");
    live.unload();
    expect(embed.writes).toEqual(["typed", "more"]);
    expect(embed.calls.slice(-2)).toEqual(["showPreview(true)", "unload"]);
    // Once.
    live.unload();
    expect(embed.calls.filter((c) => c === "unload")).toHaveLength(1);
  });

  test("a missing member gives null with a single warning per app, saying why and that notes are shown read-only; a creator that throws too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = {};
    expect(openEmbed(app as never, file as never, "", container(), "f")).toBeNull();
    expect(openEmbed(app as never, file as never, "", container(), "f")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe("Link Figures: notes on cards cannot be edited here (Obsidian's embed is not available); they are shown read-only.");

    const { registry } = fakeEmbedRegistry();
    // An embed without `showEditor`.
    const broken = { getEmbedCreator: () => (ctx: never, f: never, s: string) => Object.assign(registry.getEmbedCreator(file)!(ctx, f, s), { showEditor: undefined }) };
    expect(openEmbed({ embedRegistry: broken } as never, file as never, "", container(), "f")).toBeNull();
    expect(String(warn.mock.calls[1][0])).toBe("Link Figures: notes on cards cannot be edited here (Obsidian's note embed has changed: it has no showEditor()); they are shown read-only.");
    const throwing = { getEmbedCreator: () => () => { throw new Error("boom"); } };
    expect(openEmbed({ embedRegistry: throwing } as never, file as never, "", container(), "f")).toBeNull();
    expect(String(warn.mock.calls[2][0])).toBe("Link Figures: notes on cards cannot be edited here (Obsidian's note embed failed: boom); they are shown read-only.");
    // No creator for a note.
    expect(openEmbed({ embedRegistry: { getEmbedCreator: () => null } } as never, file as never, "", container(), "f")).toBeNull();
    expect(String(warn.mock.calls[3][0])).toBe("Link Figures: notes on cards cannot be edited here (Obsidian has no embed for notes); they are shown read-only.");
    expect(warn).toHaveBeenCalledTimes(4);
  });

  test("a file that is not a note has no creator: null, and the one warning is not used up", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registry } = fakeEmbedRegistry();
    const app = { embedRegistry: registry };
    expect(openEmbed(app as never, { path: "a.png", extension: "png" } as never, "", container(), "f")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(openEmbed({ embedRegistry: { getEmbedCreator: () => null } } as never, { path: "a.pdf", extension: "pdf" } as never, "", container(), "f")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("a save that throws as the edit ends does not keep the embed loaded", () => {
    const { registry, embeds } = fakeEmbedRegistry();
    const live = openEmbed({ embedRegistry: registry } as never, file as never, "", container(), "f")!;
    const embed = embeds[0];
    live.edit();
    embed.showPreview = () => {
      throw new Error("disk full");
    };
    expect(() => live.unload()).toThrow("disk full");
    expect(embed.unloaded).toBe(true);
    // Once, even so.
    live.unload();
    expect(embed.calls.filter((c) => c === "unload")).toHaveLength(1);
  });

  test("an editor that cannot report its end (no editMode.register) is closed again with a save, with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registry, embeds } = fakeEmbedRegistry();
    const changes: boolean[] = [];
    const app = { embedRegistry: registry };
    const live = openEmbed(app as never, file as never, "", container(), "f", { onEditingChange: (e) => changes.push(e) })!;
    const embed = embeds[0];
    const showEditor = embed.showEditor.bind(embed);
    embed.showEditor = (at?: unknown) => {
      showEditor(at);
      (embed.editMode as { register?: unknown }).register = undefined;
    };
    live.edit();
    expect(live.editing()).toBe(false);
    expect(embed.calls).toContain("showPreview(true)");
    expect(changes).toEqual([]);
    live.edit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^Link Figures: notes on cards cannot be edited here \(Obsidian's note editor has changed: .*register.*\); they are shown read-only\.$/);
  });
});

describe("noteFile", () => {
  test("the vault's file at the path, or null", () => {
    const app = { vault: { getFileByPath: (p: string) => (p === file.path ? file : null) } };
    expect(noteFile(app as never, "Notes/a.md")).toBe(file);
    expect(noteFile(app as never, "Notes/b.md")).toBeNull();
    expect(noteFile({} as never, "Notes/a.md")).toBeNull();
  });
});
