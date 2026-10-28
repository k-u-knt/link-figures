# Link Figures

Link Figures is an Obsidian desktop plugin: a page-based figure and slide editor where every panel is a live link to its source, so a figure updates when the image, PDF or TIFF behind it changes.

A figure is a note (`<name>.lnkfig.md`) that lists its links in a `## Links` section and holds the layout as JSON. Obsidian keeps those links up to date when a source is renamed or moved, like any other link in your vault.

Status: milestone 1, the walking skeleton. Desktop only.

## Usage

**New figure.** Run "Link Figures: New figure" from the command palette, or click the image icon in the ribbon. A one-page figure of the default page preset is created beside the active note and opened in the figure view. Files with the `link-figures` frontmatter key open in the figure view by themselves; "Open as markdown" shows the source of the current figure, and "Open as figure" switches a note back.

**Adding panels.** Drop or paste onto the stage:

- a file or a note section dragged from Obsidian's file explorer or from a note (a PNG, JPEG, SVG, PDF or TIFF becomes an image panel, a note becomes a content card showing that note or heading);
- a file dragged in from the operating system, or an image on the clipboard: it is copied into the vault (into the attachment folder below, or Obsidian's own attachment setting) and linked;
- text that is a link, `![[plot.png]]` or `[[analysis#Figure 2 legend]]`, pasted from the clipboard.

**Link badge.** Every panel carries a small link badge. Click it to open the source in Obsidian (hold Cmd or Ctrl to open it in a new tab). A red badge means the link cannot be followed, and says why: the file or the heading is gone, a note has no image in that section, or the file could not be decoded. Select a panel and run "Open source" for the same thing from the keyboard.

**Live update.** When the file behind a panel changes, the panel is redrawn within a moment. A file that is re-created or renamed back is picked up as well. Renaming a source in Obsidian rewrites the figure's `## Links` section; the panel stays where it is, and so does your undo history.

**Pages and the inspector.** A figure has one or more pages, each with its own preset (Nature, Elsevier and Cell column widths, A4, Letter, 16:9 and 4:3 slides), paper colour and margins. "Add page" and "Delete page" are in the toolbar. The inspector beside the stage shows the fields of what is selected: the page when nothing is, and for a panel its position, size, rotation, opacity, name, whether it is locked and, for a PDF or TIFF, which page of the file it shows.

**Moving and sizing.** Click to select, drag to move, drag a handle to resize, drag on empty paper to select several. Arrow keys nudge (hold Shift for larger steps), Delete removes, Cmd or Ctrl+Z and Shift+Cmd+Z undo and redo, Cmd or Ctrl+scroll zooms, scrolling pans, and the space bar or the middle button drags the canvas.

**Text labels.** "Text" in the toolbar adds a label for panel letters and captions. Double-click it to edit in place. Its font (a short list of common families), size in points, weight, style, colour, alignment and line height are in the inspector.

**Export.** "Export" in the toolbar opens a dialog: choose SVG or PDF (vector), the current page or all pages, and the resolution used for what has to be drawn as pixels. An SVG export is one file per page, and an SVG panel stays editable in Inkscape. A PDF export is one file with a page for each page exported, and a PDF panel is embedded in it as a vector. Files are written next to the figure, or into the export folder below.

PDF export sets text in the built-in Helvetica for Arial and Helvetica, and in Times for Times New Roman; every other family (Calibri, Georgia, Courier New) falls back to Times, with a warning, until TrueType embedding lands in M2.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Open figure files as figures | on | Open notes that carry the `link-figures` frontmatter key in the figure view. "Open as markdown" still shows the source. |
| Default page preset | Nature - double column | Page size of a new figure. |
| Attachment folder | empty | Folder for images dropped or pasted into a figure. Empty uses Obsidian's own attachment setting. |
| Export folder | empty | Folder for exported files. Empty saves them next to the figure. |
| Export resolution | 300 dpi | Dots per inch for what is drawn as pixels, from 72 to 1200. |

## Security

An SVG panel is inlined into the figure's document on export, so the linked file's markup is cleaned first. The sanitiser removes `<script>` and `<foreignObject>` elements (under any namespace prefix) with everything they hold, every `on…` event attribute, every `href` (under any prefix) that does not point into the document (`#id`) or carry inline data (`data:`), `javascript:` links included, and every `url()` in an attribute or a `<style>` rule that does not; `<style>` at-rules (`@import`, `@font-face`, `@media`) go too, and the remaining rules are scoped to the panel. Each reference removed is reported in the export's warnings. The markup is read with a tokenizer rather than regular expressions, so that a stray quote cannot hide an attribute, every tag is written again from the attributes it keeps, and the cleaning is repeated until nothing changes, so that removing one thing cannot leave another behind. This matters for the PDF export, which fetches what `<image>` points at and turns `<a>` into link annotations, and for the SVG export when a browser opens it.

## Spike results

Milestone 1 also settles three things the design leaves open. Run each check in Obsidian (with the test vault, below) and fill in the result.

**Local fonts.** Run "Link Figures: Check local font access" from the command palette. It reports whether `window.queryLocalFonts` exists in Obsidian's Electron and how many fonts it returns, or the name of the error. This decides how M2 finds TrueType files for PDF embedding.

- Obsidian version and platform: Obsidian 1.14.5 (Electron 43.8.3, Chromium 150), macOS (Darwin 27.2.0), 2026-10-28
- Result: `window.queryLocalFonts` exists and returned 623 fonts, with no permission prompt.

**View-switch timing.** Opening a figure file starts in the markdown view and switches to the figure view. Open a figure from the file explorer, from a link, and by restarting Obsidian with one open, and note how long the markdown view shows and whether it is acceptable. If it is not, M2 wraps `setViewState` instead of reacting to the file-open events.

- Opened from the file explorer: the markdown view showed for about 37 ms (2 frames).
- Opened from a link: about 14 ms (1 frame).
- Restored on startup: no markdown view at all, because the workspace stores the figure view type.
- Verdict: acceptable on timing alone, but the hook that reacted to the open broke Back: Back popped the markdown entry and the hook pushed the figure entry again (see manual-checks-m1.md, Task 8). Fix wave 2 wraps `WorkspaceLeaf.setViewState` (through `monkey-around`) so a figure file opens in the figure view in one step: the markdown flash is gone and Back reaches the note. The `file-open` hook remains as the fallback.

**External changes to a figure file.** A claim to confirm, not yet seen in Obsidian: reading Obsidian 1.14.5's `app.js` during M1, the implementer found that the text file view re-reads a file that is modified from outside the view (a link update after a rename, a sync, another editor) and hands the text to the plugin's `setViewData(text, false)`, merging three ways when the view has unsaved changes. The plugin takes that call up without reloading the figure when only link targets differ, and listens to the file's own modify event as well in case a version does not make the call, so it works either way. With a figure open, rename one of its sources in the file explorer and edit the figure file in another editor; note whether `setViewData` is called (a breakpoint or a `console.log` in it) and whether the figure keeps its selection and undo history.

- Obsidian version and platform: Obsidian 1.14.5 (Electron 43.8.3, Chromium 150), macOS (Darwin 27.2.0), 2026-10-28
- Confirmed or struck: confirmed. `setViewData(text, false)` is called when a source rename rewrites the Links section; the figure keeps its selection and undo history, and the panel re-resolves. It is also called (clear = false) for an external edit of the figure file, which reloads the figure as an ordinary change.

## Roadmap

M2 is the editor (shapes and lines, fills, alignment, crop, groups, PNG, TIFF and PowerPoint export); M3 is presentation mode, figures embedded in notes, hover previews and the community plugin submission. The design, the file format and the milestones are in [docs/superpowers/specs/2026-10-27-link-figures-design.md](docs/superpowers/specs/2026-10-27-link-figures-design.md).

## Development

Open `test-vault` in Obsidian and enable Link Figures under Community plugins. Then:

```sh
npm install
npm run dev        # rebuild main.js on every change
npm run deploy     # copy main.js, manifest.json and styles.css into test-vault (and into $OBSIDIAN_VAULT, if set)
npm test           # unit tests (vitest)
npm run typecheck  # tsc --noEmit
```

`node scripts/make-fixtures.mjs test-vault/Notes` writes the fixture sources (a PNG, an SVG, a two-page PDF and a 16-bit TIFF); add `--alt` to swap the PNG's colours and see a panel update live.
