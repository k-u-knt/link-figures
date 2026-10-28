import { renamedLinkFiles } from "../../src/links/resolver";

/** An access whose links find a file only for the names in `resolving`. */
const access = (...resolving: string[]) => ({
  resolveLink: (name: string) => (resolving.includes(name) ? { path: name, extension: name.split(".").pop() ?? "" } : null),
});

/** Obsidian's linktext for the renamed file: its shortest unique name, here the base name. */
const baseName = (newPath: string) => (omitMd: boolean) => {
  const name = newPath.split("/").pop()!;
  return omitMd ? name.replace(/\.md$/i, "") : name;
};

const renames = (oldPath: string, newPath: string, resolving: string[] = []) =>
  Object.fromEntries(renamedLinkFiles(oldPath, newPath, "Figs/f.lnkfig.md", access(...resolving), baseName(newPath)));

test.each([
  [
    "a note: every tail, each with and without .md; the full path stays full, a shorter one becomes the linktext",
    "Notes/sub/analysis.md",
    "Notes/sub/results.md",
    [],
    {
      "Notes/sub/analysis.md": "Notes/sub/results.md",
      "Notes/sub/analysis": "Notes/sub/results",
      "sub/analysis.md": "results.md",
      "sub/analysis": "results",
      "analysis.md": "results.md",
      analysis: "results",
    },
  ],
  [
    "a note whose extension is in capitals",
    "Notes/A.MD",
    "Notes/B.MD",
    [],
    { "Notes/A.MD": "Notes/B.MD", "Notes/A": "Notes/B", "A.MD": "B.MD", A: "B" },
  ],
  ["a file that is not a note has no form without its extension", "plots/a.png", "plots/b.png", [], { "plots/a.png": "plots/b.png", "a.png": "b.png" }],
  ["a file at the vault root has its full path only", "plot.png", "img/plot2.png", [], { "plot.png": "img/plot2.png" }],
  [
    "a name that still finds a file is skipped (here a folder move: the base name finds the moved file)",
    "a/b/plot.png",
    "a/c/plot.png",
    ["plot.png"],
    { "a/b/plot.png": "a/c/plot.png", "b/plot.png": "plot.png" },
  ],
])("%s", (_name, oldPath, newPath, resolving, expected) => {
  expect(renames(oldPath, newPath, resolving)).toEqual(expected);
});
