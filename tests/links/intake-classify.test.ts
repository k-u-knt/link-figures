import { classifyDrop, classifyPaste, dedupeName, linkSafeName } from "../../src/links/intake-classify";

// The brief's six cases, verbatim.
test("explorer file drag", () => expect(classifyDrop({ draggable: { type: "file", paths: ["Notes/plot.png"] } })).toEqual([{ kind: "link-file", path: "Notes/plot.png" }]));
test("OS files: panel extensions only", () => expect(classifyDrop({ osFiles: [{ name: "a.png", type: "image/png" }, { name: "b.txt", type: "text/plain" }, { name: "c.pdf", type: "application/pdf" }, { name: "d.tif", type: "image/tiff" }] })).toEqual([{ kind: "save-file", index: 0, name: "a.png" }, { kind: "save-file", index: 2, name: "c.pdf" }, { kind: "save-file", index: 3, name: "d.tif" }]));
test("dropped wikilink text", () => expect(classifyDrop({ text: "![[analysis#^fig2b]]" })).toEqual([{ kind: "link-text", linktext: "analysis#^fig2b" }]));
test("paste image names by timestamp", () => { const a = classifyPaste([{ type: "image/png" }], new Date(2026, 9, 27, 14, 5, 9)); expect(a).toEqual([{ kind: "save-image-blob", index: 0, name: "Pasted image 20261027140509.png" }]); });
test("paste text with two links", () => expect(classifyPaste([{ type: "text/plain", text: "see [[a.md]] and ![[b.png]]" }], new Date())).toHaveLength(2));
test("dedupeName", () => { const taken = new Set(["plot.png", "plot 1.png"]); expect(dedupeName("plot.png", n => taken.has(n))).toBe("plot 2.png"); expect(dedupeName("new.png", n => taken.has(n))).toBe("new.png"); });

describe("classifyDrop: Obsidian drags", () => {
  test("a multi-file drag links every file, in order", () => {
    const out = classifyDrop({ draggable: { type: "files", paths: ["a/one.png", "b/two.md"] } });
    expect(out).toEqual([{ kind: "link-file", path: "a/one.png" }, { kind: "link-file", path: "b/two.md" }]);
  });

  test("a link drag gives its linktext and the note it came from", () => {
    const out = classifyDrop({ draggable: { type: "link", linktext: "analysis#Figure 2 legend", sourcePath: "Notes/a.md" } });
    expect(out).toEqual([{ kind: "link-text", linktext: "analysis#Figure 2 legend", sourcePath: "Notes/a.md" }]);
  });

  test("a link drag without a source note has no sourcePath on its action; text links never have one", () => {
    const [drag] = classifyDrop({ draggable: { type: "link", linktext: "a.png" } });
    expect("sourcePath" in drag).toBe(false);
    const [text] = classifyDrop({ text: "[[a.png]]" });
    expect("sourcePath" in text).toBe(false);
  });

  test("a link drag without a linktext, a file drag without paths and a folder drag give nothing", () => {
    expect(classifyDrop({ draggable: { type: "link" } })).toEqual([]);
    expect(classifyDrop({ draggable: { type: "file" } })).toEqual([]);
    expect(classifyDrop({ draggable: { type: "folder", paths: ["Notes"] } })).toEqual([]);
  });

  test("a link drag that names no file (a heading of its own note) gives nothing", () => {
    expect(classifyDrop({ draggable: { type: "link", linktext: "#Heading", sourcePath: "Notes/a.md" } })).toEqual([]);
  });

  test("an Obsidian drag wins over the text that travels with it", () => {
    const out = classifyDrop({ draggable: { type: "file", paths: ["p.png"] }, text: "![[other.png]]" });
    expect(out).toEqual([{ kind: "link-file", path: "p.png" }]);
  });

  test("a folder drag is not read as the text that travels with it either", () => {
    expect(classifyDrop({ draggable: { type: "folder", paths: ["Notes"] }, text: "![[other.png]]" })).toEqual([]);
  });
});

describe("classifyDrop: files from the OS", () => {
  test("extensions are matched case-insensitively", () => {
    const out = classifyDrop({ osFiles: [{ name: "SCAN.PNG", type: "" }, { name: "Fig.Tiff", type: "" }] });
    expect(out).toEqual([{ kind: "save-file", index: 0, name: "SCAN.PNG" }, { kind: "save-file", index: 1, name: "Fig.Tiff" }]);
  });

  test("a note, a folder (no extension), a hidden file and a double extension are skipped, and indexes stay those of the dropped list", () => {
    const out = classifyDrop({
      osFiles: [{ name: "note.md", type: "" }, { name: "folder", type: "" }, { name: ".png", type: "" }, { name: "x.png.zip", type: "" }, { name: "ok.svg", type: "image/svg+xml" }],
    });
    expect(out).toEqual([{ kind: "save-file", index: 4, name: "ok.svg" }]);
  });

  test("the files win over the text", () => {
    const out = classifyDrop({ osFiles: [{ name: "a.png", type: "image/png" }], text: "![[b.png]]" });
    expect(out).toEqual([{ kind: "save-file", index: 0, name: "a.png" }]);
  });

  test("only files that were all skipped give nothing, not the text", () => {
    expect(classifyDrop({ osFiles: [{ name: "b.txt", type: "text/plain" }], text: "![[b.png]]" })).toEqual([]);
  });
});

describe("wikilinks in text", () => {
  test("embeds and plain links alike, in order, one action each", () => {
    expect(classifyDrop({ text: "[[a.md]] then ![[b.png#^id]]\nand ![[c]]" })).toEqual([
      { kind: "link-text", linktext: "a.md" },
      { kind: "link-text", linktext: "b.png#^id" },
      { kind: "link-text", linktext: "c" },
    ]);
  });

  test("an alias or size is dropped and the linktext trimmed", () => {
    expect(classifyDrop({ text: "[[a.md|my alias]] ![[plot.png|300]] [[ spaced name ]]" })).toEqual([
      { kind: "link-text", linktext: "a.md" },
      { kind: "link-text", linktext: "plot.png" },
      { kind: "link-text", linktext: "spaced name" },
    ]);
  });

  test("a link that names no file (a heading of the note it came from) is skipped", () => {
    expect(classifyDrop({ text: "[[#Heading]] [[|alias]] [[]]" })).toEqual([]);
  });

  test("one line without wikilinks may be a vault path (the fallback when Obsidian's drag object is absent), trimmed", () => {
    expect(classifyDrop({ text: "  Notes/plot.png\n" })).toEqual([{ kind: "maybe-path", text: "Notes/plot.png" }]);
    expect(classifyDrop({ text: "just some words [not a link] [[unclosed" })).toEqual([{ kind: "maybe-path", text: "just some words [not a link] [[unclosed" }]);
  });

  test("text of several lines without wikilinks, blank text or none at all gives nothing", () => {
    expect(classifyDrop({ text: "Notes/a.png\nNotes/b.png" })).toEqual([]);
    expect(classifyDrop({ text: " \n " })).toEqual([]);
    expect(classifyDrop({ text: "" })).toEqual([]);
    expect(classifyDrop({})).toEqual([]);
  });

  test("text with a wikilink is read for its links only, never as a path", () => {
    expect(classifyDrop({ text: "see [[a.png]]" })).toEqual([{ kind: "link-text", linktext: "a.png" }]);
  });

  test("a link does not run across lines", () => {
    expect(classifyDrop({ text: "[[a\nb]]" })).toEqual([]);
  });
});

describe("classifyPaste", () => {
  const when = new Date(2026, 0, 2, 3, 4, 5);

  test("the timestamp is zero-padded", () => {
    expect(classifyPaste([{ type: "image/png" }], when)).toEqual([{ kind: "save-image-blob", index: 0, name: "Pasted image 20260102030405.png" }]);
  });

  test("the extension follows the image type", () => {
    const out = classifyPaste([{ type: "image/jpeg" }, { type: "image/gif" }, { type: "image/svg+xml" }, { type: "image/tiff" }, { type: "image/webp" }], when);
    expect(out.map((a) => (a.kind === "save-image-blob" ? a.name.slice(a.name.lastIndexOf(".")) : ""))).toEqual([".jpg", ".gif", ".svg", ".tif", ".webp"]);
  });

  test("an image type the plugin cannot show is skipped", () => {
    expect(classifyPaste([{ type: "image/heic" }, { type: "image/x-unknown" }], when)).toEqual([]);
  });

  test("indexes are positions in the clipboard's item list", () => {
    const out = classifyPaste([{ type: "text/html" }, { type: "text/plain", text: "![[a.png]]" }, { type: "image/png" }], when);
    expect(out).toEqual([{ kind: "link-text", linktext: "a.png" }, { kind: "save-image-blob", index: 2, name: "Pasted image 20260102030405.png" }]);
  });

  test("text without wikilinks and non-image items give nothing", () => {
    expect(classifyPaste([{ type: "text/plain", text: "hello" }, { type: "application/pdf" }, { type: "text/html", text: "[[a]]" }], when)).toEqual([]);
  });

  test("an empty clipboard gives nothing", () => expect(classifyPaste([], when)).toEqual([]));
});

describe("dedupeName", () => {
  test("a taken name gets the first free number before the extension", () => {
    expect(dedupeName("plot.png", (n) => n === "plot.png")).toBe("plot 1.png");
  });

  test("only the last dot starts the extension", () => {
    expect(dedupeName("run.2026.png", (n) => n === "run.2026.png")).toBe("run.2026 1.png");
  });

  test("a name without an extension, and a hidden file, get the number at the end", () => {
    expect(dedupeName("README", (n) => n === "README")).toBe("README 1");
    expect(dedupeName(".png", (n) => n === ".png")).toBe(".png 1");
  });

  test("asks about each candidate once, in order, and does not call for a free name twice", () => {
    const asked: string[] = [];
    expect(dedupeName("a.png", (n) => (asked.push(n), n !== "a 2.png"))).toBe("a 2.png");
    expect(asked).toEqual(["a.png", "a 1.png", "a 2.png"]);
  });
});

describe("linkSafeName", () => {
  test("each character a link cannot hold becomes '-'", () => {
    expect(linkSafeName("plot #3.png")).toBe("plot -3.png");
    expect(linkSafeName("a [b].png")).toBe("a -b-.png");
    expect(linkSafeName("x^y|z.png")).toBe("x-y-z.png");
  });

  test("a run of them, with the dashes beside it, becomes one '-'; other dashes stay", () => {
    expect(linkSafeName("a [[b]] c.png")).toBe("a -b- c.png");
    expect(linkSafeName("a-#-b.png")).toBe("a-b.png");
    expect(linkSafeName("plot--v2.png")).toBe("plot--v2.png");
  });

  test("a name with nothing to replace, a pasted image's, is left alone", () =>
    expect(linkSafeName("Pasted image 20261027140509.png")).toBe("Pasted image 20261027140509.png"));
});

describe("classifyDrop: text and images dragged out of a note's editor", () => {
  const match = { path: "Notes/a.md", from: 2, to: 4 };
  const finds = (expected: string) => vi.fn((text: string) => (text === expected ? match : null));

  test("text that is an open note's selection becomes one link-block action, with the note and the lines", () => {
    const selection = finds("The cells divide.\nThen they [[grow]].");
    const out = classifyDrop({ text: "The cells divide.\nThen they [[grow]].", fromNote: "block-id", selection });
    expect(out).toEqual([{ kind: "link-block", notePath: "Notes/a.md", from: 2, to: 4 }]);
    expect(classifyDrop({ text: "The cells divide.\nThen they [[grow]].", fromNote: "heading", selection })).toEqual(out);
  });

  test("a selection made only of wikilinks and embeds keeps one panel per link, read relative to its note", () => {
    const text = "![[plot.png]]\n  [[analysis#Fig 2|see]] ";
    const out = classifyDrop({ text, fromNote: "block-id", selection: finds(text) });
    expect(out).toEqual([
      { kind: "link-text", linktext: "plot.png", sourcePath: "Notes/a.md" },
      { kind: "link-text", linktext: "analysis#Fig 2", sourcePath: "Notes/a.md" },
    ]);
  });

  test("Markdown embeds and links count as links: a selection of them only is read per link, from its note", () => {
    const text = "![](img/a.png) [see](Notes/b.md) [[c.png]]";
    expect(classifyDrop({ text, fromNote: "block-id", selection: finds(text) })).toEqual([
      { kind: "link-text", linktext: "c.png", sourcePath: "Notes/a.md" },
      { kind: "link-text", linktext: "img/a.png", sourcePath: "Notes/a.md" },
      { kind: "link-text", linktext: "Notes/b.md", sourcePath: "Notes/a.md" },
    ]);
    // A web link names no vault file, and text around the links makes it a block.
    expect(classifyDrop({ text: "[x](https://e.org)", fromNote: "block-id", selection: finds("[x](https://e.org)") })).toEqual([]);
    expect(classifyDrop({ text: "see ![](a.png)", fromNote: "block-id", selection: finds("see ![](a.png)") })[0].kind).toBe("link-block");
  });

  test("text that is no open note's selection is read as before", () => {
    const selection = vi.fn(() => null);
    expect(classifyDrop({ text: "see [[a.png]] here", fromNote: "block-id", selection })).toEqual([{ kind: "link-text", linktext: "a.png" }]);
    expect(classifyDrop({ text: "Notes/plot.png", fromNote: "block-id", selection })).toEqual([{ kind: "maybe-path", text: "Notes/plot.png" }]);
    expect(classifyDrop({ text: "two\nlines", fromNote: "block-id", selection })).toEqual([]);
    expect(selection).toHaveBeenCalledTimes(3);
  });

  test("with dropFromNote 'direct' (or not given) the editors are not looked at, and text is read as before", () => {
    const selection = vi.fn(() => match);
    expect(classifyDrop({ text: "see [[a.png]] here", fromNote: "direct", selection })).toEqual([{ kind: "link-text", linktext: "a.png" }]);
    expect(classifyDrop({ text: "some words", selection })).toEqual([{ kind: "maybe-path", text: "some words" }]);
    expect(selection).not.toHaveBeenCalled();
  });

  test("blank text is never matched", () => {
    const selection = vi.fn(() => match);
    expect(classifyDrop({ text: " \n ", fromNote: "block-id", selection })).toEqual([]);
    expect(selection).not.toHaveBeenCalled();
  });

  test("an image link dragged out of a note is a link-note-image, in 'block-id' and 'heading' modes", () => {
    const draggable = { type: "link" as const, linktext: "img/plot.png", sourcePath: "Notes/a.md" };
    for (const fromNote of ["block-id", "heading"] as const) {
      expect(classifyDrop({ draggable, fromNote })).toEqual([{ kind: "link-note-image", linktext: "img/plot.png", sourcePath: "Notes/a.md" }]);
    }
  });

  test("an image link stays a link-text in 'direct' mode, without a mode, without a source note, or from a figure; so does a link to a note", () => {
    const image = { type: "link" as const, linktext: "plot.png", sourcePath: "Notes/a.md" };
    expect(classifyDrop({ draggable: image, fromNote: "direct" })).toEqual([{ kind: "link-text", linktext: "plot.png", sourcePath: "Notes/a.md" }]);
    expect(classifyDrop({ draggable: image })).toEqual([{ kind: "link-text", linktext: "plot.png", sourcePath: "Notes/a.md" }]);
    expect(classifyDrop({ draggable: { type: "link", linktext: "plot.png" }, fromNote: "block-id" })).toEqual([{ kind: "link-text", linktext: "plot.png" }]);
    expect(classifyDrop({ draggable: { ...image, sourcePath: "F/fig.lnkfig.md" }, fromNote: "block-id" })[0].kind).toBe("link-text");
    expect(classifyDrop({ draggable: { ...image, linktext: "analysis#Results" }, fromNote: "block-id" })[0].kind).toBe("link-text");
  });

  test("an Obsidian drag still wins over a matched selection", () => {
    const selection = vi.fn(() => match);
    const out = classifyDrop({ draggable: { type: "file", paths: ["p.png"] }, text: "words", fromNote: "block-id", selection });
    expect(out).toEqual([{ kind: "link-file", path: "p.png" }]);
    expect(selection).not.toHaveBeenCalled();
  });
});
