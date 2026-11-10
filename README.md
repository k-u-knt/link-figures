# Link Figures

Link Figures is an Obsidian desktop plugin: a page-based figure and slide editor where every panel is a live link to its source, so a figure updates when the image, PDF or TIFF behind it changes.

A figure is a note (`<name>.lnkfig.md`) that lists its links in a `## Links` section and holds the layout as JSON. Obsidian keeps those links up to date when a source is renamed or moved, like any other link in your vault.

Status: milestone 2, part 1: shapes, connectors, paints and scripting are in, on top of the milestone 1 walking skeleton. Desktop only.

## Usage

**New figure.** Run "Link Figures: New figure" from the command palette, or click the image icon in the ribbon. A one-page figure of the default page preset is created beside the active note and opened in the figure view. Files with the `link-figures` frontmatter key open in the figure view by themselves; "Open as markdown" shows the source of the current figure, and "Open as figure" switches a note back.

**Adding panels.** Drop or paste onto the stage:

- a file or a note section dragged from Obsidian's file explorer or from a note (a PNG, JPEG, SVG, PDF or TIFF becomes an image panel, a note becomes a content card showing that note or heading);
- a file dragged in from the operating system, or an image on the clipboard: it is copied into the vault (into the attachment folder below, or Obsidian's own attachment setting) and linked;
- text that is a link, `![[plot.png]]` or `[[analysis#Figure 2 legend]]`, pasted from the clipboard.

Obsidian hides `.tif`/`.tiff` files in the file explorer unless Settings → Files and links → Detect all file extensions is on; panels from them work either way.

**Link badge.** Every panel carries a small link badge. Click it to open the source in Obsidian (hold Cmd or Ctrl to open it in a new tab). A red badge means the link cannot be followed, and says why: the file or the heading is gone, a note has no image in that section, or the file could not be decoded. Select a panel and run "Open source" for the same thing from the keyboard.

**Live update.** When the file behind a panel changes, the panel is redrawn within a moment. A file that is re-created or renamed back is picked up as well. Renaming a source in Obsidian rewrites the figure's `## Links` section; the panel stays where it is, and so does your undo history.

**Pages and the inspector.** A figure has one or more pages, each with its own preset (Nature, Elsevier and Cell column widths, A4, Letter, 16:9 and 4:3 slides), paper colour and margins. "Add page" and "Delete page" are in the toolbar. The inspector beside the stage shows the fields of what is selected: the page when nothing is, and for a panel its position, size, rotation, opacity, name, whether it is locked and, for a PDF or TIFF, which page of the file it shows. A locked panel cannot be moved, resized or deleted, but it can still be selected (its outline is dashed and it has no handles) and unlocked there. Dragging from a locked panel selects what the dragged rectangle touches, as dragging on empty paper does, so a locked background does not get in the way.

**Moving and sizing.** Click to select, drag to move, drag a handle to resize, drag on empty paper to select several. Arrow keys nudge (hold Shift for larger steps), Delete removes, Cmd or Ctrl+Z and Shift+Cmd+Z undo and redo, Cmd or Ctrl+scroll zooms, scrolling pans, and the space bar or the middle button drags the canvas. A panel can be resized freely; "Reset aspect ratio" (in the toolbar and the command palette) gives the selected image panels the height their image has at their width, following the crop when a panel shows only part of its image.

**Text labels.** "Text" in the toolbar (or "Link Figures: Text" in the command palette) arms the text tool for panel letters and captions: click on the page to place a label there, and type (what you type replaces "Text"). Escape, a click off the pages, or "Text" again puts the tool down without adding anything. Double-click a label to edit it again. Its font (the installed families), size in points, weight, style, colour, alignment and line height are in the inspector.

**Export.** "Export" in the toolbar opens a dialog: choose a format, the current page or all pages, and the resolution (dpi; the 300, 600 and 1000 buttons set the resolutions journals ask for). The chosen format's own options appear under the Format menu. Files are written next to the figure, or into the export folder below.

- **SVG** (vector): one file per page, `<figure> - <page>.svg`. An SVG panel stays editable in Inkscape. The dpi is for what has to be drawn as pixels (PDF pages and note content).
- **PDF** (vector): one file with a page for each page exported. A PDF panel is embedded in it as a vector.
- **PNG**: one file per page, `<figure> - <page>.png`, the whole page drawn at the dpi, with the dpi written into the file (`pHYs`) and marked sRGB. No options.
- **TIFF**: one file per page, `<figure> - <page>.tif`, 8-bit RGB with the dpi as its resolution. Option: Compression, Deflate (the default) or None. Obsidian's file explorer hides `.tif` files unless "Detect all file extensions" (Settings → Files and links) is on; the files are in the folder either way.

PNG and TIFF draw the same page SVG as the SVG and PDF exports, so all four look the same. They are flattened onto the page's paper colour (white when the paper is transparent: turn off the checkbox beside the Page inspector's "Paper", or `page.update` with `{ paper: "transparent" }`; SVG and PDF then have no paper rectangle). Every export waits for the figure to finish drawing (links resolved, images loaded, content cards rendered) for at most 30 s, and then goes on with the report line `"<figure>": exported before every item was drawn`. Asking for Export while its dialog is open brings that dialog back to the front instead of opening a second. PDF panels are drawn from their rasters at the export dpi, content cards from a snapshot of the stage, and text in the fonts installed on your computer. A page too large to draw at the dpi you asked for (Chromium's canvas holds at most 16 384 px on a side and 268 million pixels) is drawn at the largest dpi that fits, and the notice says `"<page>": drawn at <n> dpi (the largest that fits)`. A page that cannot be drawn at all is named in the notice, and the other pages are still written. PNG and TIFF are 8-bit sRGB, which is what a browser canvas holds: there is no CMYK, no ICC profile other than the sRGB mark, and no 16-bit output. A4 at 1000 dpi is about 8 300 × 11 700 px, whose canvas alone takes some 390 MB of memory while it is drawn, so it takes a few seconds; 300 or 600 dpi is enough for most journals.

**Items of a type no plugin provides.** A figure that holds an item another plugin made (a `type` this plugin does not know) still opens when that plugin is missing. The item is kept exactly as the file has it, drawn as a dashed placeholder labelled "Missing: <type>", and saved unchanged, so no data is lost. It can be moved, resized, grouped and deleted, its inspector shows only the base fields, and connectors keep their ends on it (attached to its box). Every export skips it with the line `"<type>" item skipped: no plugin draws it`. A plugin that registers the type can give it a `migrate(raw)` hook to validate the item when the figure loads; if the hook throws, the item is kept as it is, drawn as "Unreadable: <type>", skipped on export with `"<type>" item skipped: its plugin could not read it`, and one Notice per type says so when the figure opens. A plugin that registers a type while a figure is open takes over from the next time the figure is opened.

**Trimmed export.** What a crop hides is left out of the exported file, so the data you cropped away is not sent along with the figure. Every export removes from each panel's source what lies wholly outside the part that shows (the crop, and what the panel's rectangle cuts off when it is filled): a PNG, JPEG, GIF, WebP, AVIF, BMP or TIFF panel is cut to the visible pixels (rounded outward to whole pixels), and so is a PDF panel's image in an SVG export. An item that crosses the crop's edge (a line, an axis, a long label, or an image embedded in an SVG or PDF plot, such as a heat map) is kept whole, and its hidden part is still in the file under the clip. A trimmed raster is written as a PNG in sRGB, as the stage shows it: an embedded colour profile is not carried over, a JPEG can grow several times in size, and an animated GIF keeps its first frame. The export's notice has a line for each cropped panel saying what was removed, or why it could not be trimmed. The figure itself keeps the full sources, so a crop can always be widened again.

**Fonts in the PDF.** PDF export embeds the fonts a label or a linked SVG panel uses, as a subset holding only the characters drawn, so one word costs a few kilobytes. The fonts come from the ones installed on your computer (Obsidian lists them; the inspector's Font menu shows the same list), and only TrueType outlines can be embedded. When a font cannot be, the next name in the family list is tried; when none can, the text is set in a standard font and the export's notice says so, naming the font actually used. That font is Times, unless the list reaches a generic name first (`sans-serif`, or Arial or Verdana, gives Helvetica; `monospace` gives Courier; `serif` gives Times). A label's family is a single name, so a label in a font that cannot be embedded is set in Times. Arial, Helvetica and Times New Roman that are not installed are drawn as the standard Helvetica and Times, which match their metrics, with no warning; installed as TrueType, they are embedded like any other font. The warnings are:

- `font "X" not installed — Times used in PDF` (or the font the list reached)
- `font "X" has PostScript outlines (OTF/CFF) — Times used in PDF` (an `.otf` family, or a collection of such faces, as Hiragino Sans)
- `font "X" could not be read — Times used in PDF`
- `font "X" has no bold face — regular used` (likewise italic and bold italic)
- `font "X" lacks "µ" — "label" set in Helvetica in PDF` (a character the font has no glyph for; the whole label is set in Helvetica for a sans-serif font or Times for a serif one, rather than cut short). The standard fonts hold only Latin-1 and a few typographic marks, so a character outside them, such as `→`, is drawn as `?`, and the warning ends `; "→" shown as ?`.
- `"→" cannot be shown in Times — replaced by "?" in PDF` (any text drawn in a standard font, such as a font that is not installed or a not-installed Arial; a minus sign `−`, thin spaces and non-breaking hyphens are drawn as their look-alikes `-`, space and `-` with no warning)
- `installed fonts could not be read (Obsidian was not visible) — fonts substituted` (Obsidian refuses the font list while its window is hidden; export with the window showing)

A warning that comes from a label or an SVG panel starts with its name. A linked SVG's fonts are read from its `font-family`, its `font` shorthand (as matplotlib writes with `svg.fonttype: none`) and its style rules, and a list such as `Calibri, sans-serif` tries each name in turn; Arial, Helvetica or Times New Roman in a list is used as the standard font and ends the search. Each embedded face is named by its own PostScript name (`Georgia-Bold`), without the six-letter subset prefix, so a preflight tool may not list them as subsets. An installed font called Helvetica, Times or Courier is embedded under the name `Helvetica-Embedded` (and so on) where its PostScript name is one of the standard fonts' own. An SVG export is not changed by any of this: it keeps the family names and embeds nothing.

## Shapes and connectors

**Shapes.** "Rectangle" and "Ellipse" in the toolbar (the commands `tool.rect` and `tool.ellipse`) arm a drawing tool: drag on a page to draw the shape in the dragged box (hold Shift for a square or a circle), or click to place one of 30 × 20 mm centred on the click. The tool puts itself down after the shape, which is selected. A new shape is filled white and has a 1 pt solid black border. Select it and the inspector shows its fields: for a rectangle "Corner radius" (in mm; rounds the corners, kept within half the short side), then "Fill", a "Border" toggle (off is no border) and, while there is a border, "Border paint", "Border width" (pt) and "Border dash" (Solid, Dashed, Dotted, Dash-dot). An ellipse has no field of its own. "Fill" and every "… paint" field take any of the paint types below.

**Paints.** A fill or a line (a shape's fill, a border, a connector's line, a panel's frame) is painted with one of three kinds, chosen in the paint's select: None, Colour or Pattern (hatch, reversed hatch, crosshatch, dots or grid, in a colour over an optional background, with a scale and an angle). Gradients and patterns stay vector in SVG, PDF and PowerPoint export.

**The colour slider.** "Colour" is one control for solid colours and gradients: a ramp of colour stops. One stop is a solid colour; two or more are a gradient, drawn along a line or out from a centre. A label beside the select names what the ramp is ("Solid", "Linear gradient" or "Radial gradient") and changes as you edit, so there is no gradient type to pick first.
- **The bar** draws the ramp's colours left to right (offset 0 to 1) over a checkerboard, so that opacity shows. Click the bar clearly away from the handles to add a stop there (a press within 8 px of a handle takes that handle instead), in the colour the ramp has at that point (opacity included). A solid that gains a stop becomes a linear gradient (angle 0).
- **The handles** under the bar are the stops, each filled with its colour. Drag a handle to move its stop (the whole drag is one undo step; a drag past a neighbour swaps their order; Escape during the drag puts it back). Pull a handle more than 24 px down off the bar (it shows a ×, and "Release to remove" appears) and let go to remove its stop, or select it and press Delete or Backspace. Removing down to one stop makes a solid; the last stop stays. Double-click a handle to open its colour picker. Stops stacked at one offset: each click on the stack selects the next of them. Hover a handle for a reminder of all this.
- **The keyboard.** Every handle is focusable (Tab moves between them): the arrow keys move the selected stop by 0.01 (with Shift, 0.1), Home and End take it to 0 and 1, Delete and Backspace remove it.
- **The selected stop's row** under the bar holds its colour, opacity and offset (step 0.01), with "Add stop" (half way to the next stop) and "Remove".
- **Above the bar:** ⇄ reverses the ramp (each offset becomes 1 − offset); the Linear | Radial toggle (shown for two or more stops) switches the gradient's shape and keeps the stops; ⋯ opens the presets: Solid (the selected stop's colour), Two-colour linear (the first and last colours, or black to white), Radial (the current stops) and Reverse.
- **The shape's fields** follow under the slider: "Angle" for a linear gradient (degrees, 0 left to right and 90 top to bottom); "Centre x" and "Centre y" (fractions of the box's width and height) and "Radius" (a fraction of its longer side) for a radial one.

With several items selected whose paints at that field differ (in type or in value), the label reads "Mixed" and the slider shows the first item's paint; a slider edit then writes that one paint to every selected item that has the field, and the label shows its kind. Items whose paints are equal are edited together as one. Choosing None, Colour or Pattern in the select also goes to every selected item. The file stores paints as before (`solid`, `linear`, `radial`), so figures made before the slider open and save unchanged.

**Connectors.** "Connector" in the toolbar (`tool.connector`) arms the line tool: drag from one item to another, and the line is drawn between them with an arrowhead at its end. Anything that can be attached to takes an end: a shape, a text label, an image panel or a content card (not another connector). While the tool is armed, the item under the pointer shows its anchors (its four edge midpoints, named `n`, `e`, `s` and `w`), and a drag shows the line it would make. An end dropped on an item is attached to it and follows it when it is moved, resized or rotated (the line leaves along the item's edge, as the item is turned); an end dropped on empty paper is free there. A click draws nothing. The toolbar's "Connector snap" toggle (`connector.snap-mode`) chooses what an end dropped on an item attaches to: "Connector snap: anchor", the nearest anchor, or "Connector snap: centre", the item's centre. The choice is for the open figure and is not saved with it; each end's "Start snap" and "End snap" in the inspector change an attached end afterwards.

Select a connector and the inspector shows its "Route" (Straight, Curved or Orthogonal), the route's own field ("Bend" for curved, from −1 to 1; "Bend position" for orthogonal, from 0 to 1), the line's "Line paint", "Line width" (pt) and "Line dash", and for each end its "Start cap" and "End cap" (None, Arrow, Open arrow, Circle or Bar) with "Start cap size" and "End cap size" (a multiple of the line's width, 3 by default). A selected connector has a handle on each end (drag one onto another item to attach it, or onto paper to free it) and, on a curved or an orthogonal route, a handle on the line that sets its bend (on an orthogonal route it is shown only when moving it changes the line: not for a straight run, an L or a U). A curved connector whose ends are attached leaves each item square to its edge, so its bend handle may not follow the pointer exactly.

A connector's box is the area it draws and is set for it; it is never rotated. Deleting an item a connector is attached to leaves the connector's end where it was drawn, free; undo brings the item and the attachment back.

**Frames.** An image panel can have a frame: the "Frame" toggle in its inspector, with "Frame paint", "Frame width" and "Frame dash". A frame takes the same paints and dashes as a border.

**Export.** Shapes, connectors and frames are drawn in SVG and PDF as vectors: a gradient or pattern fill or line stays a gradient or pattern, dashes stay dashes, and arrowheads are paths. If anything in them could not be written as it is drawn, the export's notice says what.

## Scripting

The plugin can be driven by scripts and by AI as well as by hand. Everything the toolbar and the inspector do is a registered command that takes JSON arguments and gives a JSON result, and the UI runs the same commands as a script does, so the two make identical documents. The commands are reached through the plugin's API:

```js
const api = app.plugins.plugins["link-figures"].api;
```

This works in the Obsidian developer console, in another plugin and in the Obsidian CLI's `eval`. A figure is named by its vault path (`Notes/My figure.lnkfig.md`).

| Call | What it does |
|---|---|
| `api.commands()` | Every registered command as `{ id, name, group, params?, needsView }`: its arguments and whether it needs the figure open (a tool or a zoom does). |
| `await api.run(path, id, args?)` | Runs one command on the figure and resolves to its result. On an open figure it is one undo step there; on a figure that is not open the file is read, changed and saved. Rejects with a `CommandError` for an unknown command, bad arguments, or a command that needs the figure open when it is not. |
| `await api.batch(path, calls)` | Runs `calls` (`[{ id, args? }, …]`) in order as one edit, all or nothing: every call is checked before any runs, and if one fails nothing changes. One undo step in an open figure, one save otherwise. Resolves to the array of their results. A `needsView` command cannot be in a batch. |
| `await api.read(path)` | The figure's document as JSON: the open view's current one, else the file's. |
| `await api.export(path, { format, pages?, dpi?, options? })` | Exports the figure as the Export dialog does, to the export folder. `format` is an exporter's id (`svg`, `pdf`, `png`, `tiff`); `pages` is `"current"` (the default: the page in focus; for a closed figure, the page the background view opens on, so name the pages or use `"all"` there), `"all"`, or a list of page ids; `dpi` is from 72 to 1200 (the setting's when left out); `options` are the format's own (`{ compression: "none" }` for TIFF), each left out at its default. Resolves to `{ files, warnings }`: the vault paths written and the notice's lines. A figure that is not open is opened in a background tab, waited on until its panels and content cards are drawn, exported and closed again. A bad format, dpi, option or page is refused before anything is opened or written. It is not a figure command, so it is not in `api.commands()`. |
| `await api.createFigure(path, { preset?, pages? })` | Creates a new figure file as "New figure" does and resolves to `{ path }` (`.lnkfig.md` is added when missing, and missing folders are made). `preset` is a page preset's id (the Default page preset setting when left out); `pages` is a whole number from 1 to 100 (1 when left out), all of the preset. Refuses, with a `CommandError` that starts `createFigure:`, a path something is already at, a path with a `.` or `..` part (so nothing is written outside the vault; a leading `/` is taken as the vault's root), a preset that does not exist (`preset: null` included) and a `pages` that is not in range. |
| `api.ramp.of(paint)`, `api.ramp.toPaint(ramp, previous?)` | Colour by the colour slider's rule. `of` reads a solid, linear or radial paint as a ramp, `{ stops, geometry }`, with the stops sorted by offset and `geometry` either `{ kind: "linear", angle }` or `{ kind: "radial", cx, cy, r }` (a solid reads as one stop on a linear ramp at angle 0); it gives `undefined` for a paint that is not a ramp (none, pattern). `toPaint` writes a ramp back: one stop is a `solid` (with `opacity` only when under 1), two or more the `linear` or `radial` paint of its geometry, with the stops sorted and kept within 0 to 1. With `previous` of the type written, its other keys are kept. A ramp whose geometry is not registered keeps the paint's type (its type's `ramp.write`, else `previous` as it was, with a console warning; with no `previous`, `toPaint` throws a `CommandError`). Neither changes a figure: pass the paint to `node.update` with `replace: ["fill"]` (the paint's top-level key), so that a key the new paint leaves out goes. |
| `api.registries` | The registries (commands, node types, shape kinds, routes, cap kinds, paint types, ramp geometries, ramp presets, shape operations, adjustments, exporters). A new shape kind, route, cap kind or paint type is one registration; nothing else changes. A paint type with a `ramp` hook (`ramp.read(paint)` gives its stops and geometry; the optional `ramp.write(ramp, previous)` writes a ramp whose geometry is not registered) is edited with the colour slider; a ramp geometry (`rampGeometries`: its `kind`, toggle name, `defaults()`, `fields()` and `toPaint(stops, geometry, previous)`) adds a shape to the slider's toggle; a ramp preset (`rampPresets`: `id`, `name`, `apply(ramp, selectedIndex)`) adds an entry to its ⋯ menu. |

Export every page of a figure as TIFF at 600 dpi, uncompressed:

```js
const { files, warnings } = await api.export("Notes/My figure.lnkfig.md", { format: "tiff", pages: "all", dpi: 600, options: { compression: "none" } });
// files => ["Notes/My figure - Page 1.tif", "Notes/My figure - Page 2.tif"]
```

Calls on one figure run one after another, so a script need not await each. With the figure open, an edit that arrives while it has an unsaved change of its own lands in the open view, as one undo step, and the unsaved change is kept.

**Commands that draw and edit.**

| Id | Arguments (defaults in brackets) | Result |
|---|---|---|
| `shape.create` | `kind` (`"rect"`), `x`, `y`, `width`, `height` (page px; required), `id`, `page`, `params`, `fill`, `border` | `{ id }` |
| `connector.create` | `from`, `to` (ends; required), `route` (`"straight"`), `routeParams`, `stroke`, `caps`, `id`, `page` | `{ id }` |
| `node.update` | `id`, `patch` (required): a part of the node in its JSON form, merged into it; `replace`: the patch's top-level keys holding a paint or a stroke that replace what is there whole | `{ id }` |
| `node.move` | `ids` (the selection when the figure is open; required headless), `dx`, `dy` (page px; required), `pages` (`true`; with `true` each moved node goes to the page under its centre, and a connector whose items all go to one page goes with them) | `{ ids }` |
| `connector.setEnd` | `id`, `which` (0 the start, 1 the end), `end` (required) | `{ id }` |
| `page.update` | `id` (a page id), `patch` (required): `name`, `preset`, `width`, `height` (mm), `paper` (`#rrggbb` or `"transparent"`), `margins` (mm), `grid`, merged into the page | `{ id }` |
| `shape.operate` | `operation` (a registered shape operation), `ids` (required) | `{ added, removed }` |

`id` is a name you choose for the new node (an id the figure already has is an error; without one, a new id is made), and a later call of the same batch can use it. `page` is the page id; with the figure open it defaults to the page in view, and with it closed it must be given (`(await api.read(path)).pages[0].id`). A new node goes above everything on its page. `shape.create` without `fill` is white, without `border` has the default border (`null` for none), and its `params` are the kind's defaults with yours over them; `connector.create` without `stroke` is a 1 pt solid black line, and without `caps` has none at the start and an arrow of size 3 at the end. In `node.update` an object is merged key by key (`{ fill: { color: "#ff0000" } }` changes only the colour), anything else replaces what was there, and a paint of another `type` replaces the old paint whole. `replace`, a list of the patch's top-level keys (`replace: ["fill"]`), makes those keys' values replace what is there whole, with no merge, so that a key the new value leaves out (a solid's `opacity`) goes. It takes only keys the patch gives that hold a paint or a stroke, as the node type's fields declare (a shape's `fill` and `border`, a connector's `stroke`, a panel's `frame`); a replaced paint must have every key of its type's defaults (`color` for a solid; `angle` and `stops` for a linear gradient…) and its type's numbers within range; a paint of a type no plugin registers is taken as it is. Anything else is refused with a `CommandError` naming `node.update` and the key, and the value is then checked as any other. A stroke (a connector's `stroke`, a shape's `border`, a panel's `frame`) has only `paint`, `width`, `dash`, `cap` and `join`: a stroke given with any other key (`{ stroke: { color: "#ff0000" } }`, where `{ stroke: { paint: { color: "#ff0000" } } }` is meant) is refused, naming the key; in `node.update` only the keys the patch gives are judged, so a key a stroke already has in the file is kept. Every field a patch changes is checked as the file needs it (a width and height not negative, and at least 1 mm as a resize keeps them, an opacity from 0 to 1, a font size above 0, a `crop` of four numbers or `null`, a `fit` of `"cover"` or `"contain"`, a page index a whole number…), so what `node.update` accepts always saves and opens again. An end attached with `snap: "anchor"` and no `anchor` takes the item's anchor nearest where the end is drawn. `page.update` merges as `node.update` does; an unknown `preset` is refused (`custom` is allowed) and a `preset` sets the page's size, a `width` or `height` that is not the preset's makes the page custom, and a size over the Maximum page size setting is cut down to it (with the figure open or not). `add-page` takes `page` (the page it goes after) and `preset` (a page preset's id, else the new page is like that page; an unknown id is refused). A `shape.create` or `panel.create` under 1 mm wide or high is refused, and `node.update` raises such a size to 1 mm. `node.update` with a `page` on a connector attached to items on another page is refused with a message that names `node.move`, which moves the items and the connector together. The inspector's page fields run it, as its node fields run `node.update`. Positions are page px, widths pt, colours `#rrggbb` with opacity separate.

**Example.** Two rectangles with names of your choosing and an arrow between them, as one edit (run with the figure open or closed; replace the path):

```sh
obsidian eval code='(async () => {
  const api = app.plugins.plugins["link-figures"].api;
  const path = "Notes/My figure.lnkfig.md";
  const page = (await api.read(path)).pages[0].id;
  return JSON.stringify(await api.batch(path, [
    { id: "shape.create", args: { id: "box-a", page, kind: "rect", x: 40, y: 60, width: 120, height: 70, params: { cornerRadius: 8 }, fill: { type: "solid", color: "#dbeafe" } } },
    { id: "shape.create", args: { id: "box-b", page, kind: "rect", x: 300, y: 60, width: 120, height: 70, fill: { type: "solid", color: "#fee2e2" } } },
    { id: "connector.create", args: { page, from: { kind: "attached", node: "box-a", snap: "anchor", anchor: "e" }, to: { kind: "attached", node: "box-b", snap: "anchor", anchor: "w" }, route: "straight" } },
  ]));
})()'
```

It prints the three results, `[{"id":"box-a"},{"id":"box-b"},{"id":"p-xxxx"}]` (the connector's id is made for it). Undo with one Cmd+Z in the open figure.

**Document schema.** The nodes the commands make, as they are in the file (`pages` and the file layout are unchanged from M1).

```ts
// A drawn shape. `kind` is a registered shape kind ("rect", "ellipse"); `params` is that kind's own attributes
// (rect: { cornerRadius } in px, 0 by default). `fill` { type: "none" } is no fill; `border` null is no border.
type ShapeNode = NodeBase & { type: "shape"; kind: string; params: Record<string, unknown>; fill: Paint; border: Stroke | null };

// A line between two ends. `route` is a registered route ("straight", "curved" with { bend }, default 0.25,
// "orthogonal" with { offset }, default 0.5). `caps` are drawn at the start and the end. Its box is the area it draws, never rotated.
type ConnectorNode = NodeBase & { type: "connector"; ends: [End, End]; route: string; routeParams: Record<string, unknown>; stroke: Stroke; caps: [Cap, Cap] };

// A free point in page px, or an attachment to any node that can be attached to: at one of its anchors
// ("n", "e", "s", "w" for a box or an ellipse; the line then leaves along that edge's normal) or at its centre.
type End =
  | { kind: "free"; x: number; y: number }
  | { kind: "attached"; node: string; snap: "anchor"; anchor: string }
  | { kind: "attached"; node: string; snap: "center" };

// A registered cap kind ("none", "arrow", "openArrow", "circle", "bar"); `size` is a multiple of the stroke's width.
type Cap = { kind: string; size: number };

// A line, painted like a fill: a shape's border, a connector's line, an image panel's `frame`. `width` is in pt.
type Stroke = { paint: Paint; width: number; dash: "solid" | "dash" | "dot" | "dashDot"; cap?: "butt" | "round" | "square"; join?: "miter" | "round" | "bevel" };

// A registered paint type's id plus its own fields; one the plugin does not know is kept as it is.
type Paint =
  | { type: "none" }
  | { type: "solid"; color: string; opacity?: number }                                  // opacity 0-1
  | { type: "linear"; angle: number; stops: Stop[] }                                    // angle in degrees, 0 left to right, 90 top to bottom
  | { type: "radial"; cx: number; cy: number; r: number; stops: Stop[] }                // fractions of the box; r of its longer side
  | { type: "pattern"; pattern: "hatch" | "hatchReverse" | "crosshatch" | "dots" | "grid"; fg: string; bg: string | null; scale: number; angle: number };
type Stop = { offset: number; color: string; opacity?: number };                        // offset 0-1
```

Reverse a shape's gradient from a script, as the slider's ⇄ does:

```js
const path = "Notes/My figure.lnkfig.md";
const shape = (await api.read(path)).nodes.find((n) => n.id === "p-1");
const ramp = api.ramp.of(shape.fill);
ramp.stops = ramp.stops.map((s) => ({ ...s, offset: 1 - s.offset }));
await api.run(path, "node.update", { id: "p-1", patch: { fill: api.ramp.toPaint(ramp, shape.fill) }, replace: ["fill"] });
```

The paint defaults are `{ type: "solid", color: "#000000" }`, a linear gradient from `#000000` to `#ffffff` at angle 0, a radial one with `cx` and `cy` 0.5 and `r` 0.5, and a black hatch at scale 1 and angle 0 with no background.

## Groups, alignment and cropping

**Groups.** Select two or more items and click "Group" (`group.create`) to treat them as one: a click on any member selects the group, and moving, resizing, deleting, duplicating, locking and restacking act on the whole. Groups nest. Double-click a group to enter it and select one member (double-click again to go a level deeper); Escape steps out one level and selects the group you left. A group draws nothing and exports as its members do. Resizing a group shows an outline and scales the members' boxes when you let go; text sizes and line widths keep their own values. A connector attaches to a member, never to the group's box.

**Align, distribute and snap.** The toolbar has Align left, centre, right, top, middle and bottom, and Distribute horizontally and vertically (three or more items). A group counts as one item. A drag snaps to the edges and centres of other items and to the page's edges, centre lines and margins, with a guide line while it holds; hold Alt during a drag to skip snapping, or turn it off with the "Snap" toggle in the toolbar (`snap.toggle`; it is a setting of the open figure, not saved with it).

**Right-click menu.** Right-click an item for what the toolbar offers for it: Duplicate, Delete, Lock and Unlock, Crop and Reset crop, Bring forward and Send backward, Group and Ungroup, the aligns and distributes, Auto display range and Reset display, Reset aspect ratio and Open source (greyed out where they do not apply). The item is selected first unless it is already part of the selection, so a right-click on one of several selected items acts on them all. Right-click a page's paper for Text, Rectangle, Ellipse, Connector, Add page, Delete page, Fit page and Export on that page, or the canvas around the pages for Add page, Fit page, Zoom to 100% and Export. The Menu key or Shift+F10 opens the menu from the keyboard. A command added by another plugin can list itself with `menu: ["item" | "page" | "canvas"]`. "Lock" and "Unlock" (`lock`, `unlock`, also in the toolbar and the palette) set `locked` on the selected items; a locked group locks everything in it.

**Crop.** Double-click an image panel (or click "Crop") to crop it on the page: drag a handle to move that edge of the crop, drag inside the box to move the image under it, Enter or a click outside to finish, Escape to cancel. The whole crop session is one undo step. A rotated panel is not cropped on the page (set its rotation to 0); the inspector's "Crop left/top/right/bottom (%)" fields and `panel.crop` work on it anyway.

| Id | Arguments (defaults in brackets) | Result |
|---|---|---|
| `group.create` | `ids` (the selection), `id` | `{ id }` |
| `group.ungroup` | `ids` (the selection) | `{ ids }`: the freed members |
| `group.add` | `group`, `ids` (required) | `{}` |
| `group.remove` | `ids` (required) | `{}` |
| `align` | `ids` (the selection), `edge` (`"left"`, `"hcenter"`, `"right"`, `"top"`, `"vcenter"` or `"bottom"`; required), `to` (`"selection"` for two or more items, else `"margins"`; or `"page"`) | `{ ids }` |
| `distribute` | `ids` (the selection), `axis` (`"horizontal"` or `"vertical"`; required), `by` (`"gap"` or `"center"`) | `{ ids }` |
| `lock` / `unlock` | `ids` (the selection) | `{ ids }`: the items whose `locked` changed |
| `panel.crop` | `id`, `crop` (`{ x, y, w, h }` as fractions of the image, or `null` for none; required), `keep` (`"image"`, the default: the image stays put and the box becomes the visible part; or `"box"`: the box stays and the image refits) | `{}` |
| `panel.crop-reset` | `id` (the selected panel); needs the figure open, as it crops with keep `"image"` | `{}` |

`keep: "image"` needs the image's size, so it works on an open figure once the image has loaded; use `keep: "box"` on a figure that is not open. `node.update` does not set `parent`; use `group.add` and `group.remove`.

```js
// Group two nodes, then line them up and crop a panel.
await api.run(path, "group.create", { ids: ["box-a", "box-b"], id: "legend" })
await api.run(path, "align", { ids: ["legend", "box-c"], edge: "top" })
await api.run(path, "panel.crop", { id: "p-aaaa", crop: { x: 0.1, y: 0.1, w: 0.6, h: 0.5 }, keep: "image" })
```

## Image display

Select a TIFF or raster panel and the inspector gets a **Display** section: for each channel (Grey, or Red, Green and Blue) a LUT (grey, inverted, red, green, blue, cyan, magenta, yellow, fire, viridis), Min and Max in the image's own sample values, Gamma, a Visible toggle, and a histogram. Drag the two handles on the histogram to set Min and Max (a handle stops at the other one; the whole drag is one undo step). The histogram is a log scale of the channel's values; the part outside Min and Max is dimmed. The toolbar and command palette have "Auto display range" (stretches each channel to its 0.35% and 99.65% percentiles, as ImageJ's Auto does) and "Reset display" (back to how the panel looked before). Channels add up (colour by colour, clamped at white), so a three-channel TIFF can be shown with any LUTs or with one channel hidden. The adjustment is stored on the panel and drawn the same on the stage and in SVG and PDF export; the linked file is never changed. A panel with no adjustment draws as before. SVG and PDF panels have no display.

The first edit starts from what the panel shows now, so only what you change changes. A TIFF's Min and Max are 0..255 for 8 bit and 0..65535 for 16 bit; a white-is-zero TIFF is shown, ranged and counted in the values you see.

| Id | Arguments (defaults in brackets) | Result |
|---|---|---|
| `panel.display` | `id` (required), `channel` (0), `set` (required): any of `min`, `max`, `gamma` (0.1 to 10), `lut` (a registered id), `visible` | `{}` |
| `panel.display-auto` | `id` (the selected panel), `channel` (all), `saturation` (0.35, below 50) | `{}` |
| `panel.display-reset` | `id` (the selected panel) | `{}` |
| `panel.histogram` | `id` (required), `channel` (0), `bins` (256, up to 4096) | `{ dataMin, dataMax, lo, hi, bitsPerSample, counts }` |

`panel.display` creates the adjustment when the panel has none and otherwise patches one channel; it needs the figure open the first time (the image's samples are read), and then works on a closed figure too. `panel.display-auto` and `panel.histogram` always need the figure open, and the image decoded; if they answer `the image is not loaded; open the figure`, try again a moment later. `panel.histogram` changes nothing: `counts` are bin counts over `[lo, hi]`, the span of the data and the shown range together.

```js
// Show channel 1 (green) of a 16-bit RGB TIFF in the Fire palette, brighter, over 1000 to 15000.
await api.run(path, "panel.display", { id: "p-aaaa", channel: 1, set: { lut: "fire", gamma: 1.5, min: 1000, max: 15000 } })
// => {}

// Count the values of an 8-bit white-is-zero TIFF in 4 bins.
await api.run(path, "panel.histogram", { id: "p-gggg", bins: 4 })
// => { dataMin: 35, dataMax: 235, lo: 0, hi: 255, bitsPerSample: 8, counts: [9216, 20992, 20736, 14592] }
```

## Linking a place in a note

Select text in a note's editor and drag it onto a figure's stage: the panel links the place the text came from, not a copy of it, so it follows the note when the note changes. One content panel is made at the pointer. The link is to the block that holds the start of the selection:

- a heading is linked by its name (`note#Heading`);
- a paragraph, list item, quote or callout, table or code block is linked by a block id (`note#^fig-3k9x`). When the block has no id, one is added to the note: ` ^id` at the end of a paragraph or list item, and `^id` on a line of its own after a table, a code block or math block, a quote or a callout (after the closing fence or last row inside a list item that ends in one). A block that has an id keeps it, also one you typed. The id is added through the note's editor when the note is open, so Undo there takes it back, and it is the only change to the note;
- a selection over several blocks links the smallest heading section that holds them all, and with no such heading it links the first block and a Notice says so;
- a selection of nothing but links (`[[plot.png]] [[cells.tif]]`) is read as the links, one panel each, as before.

An image dragged out of a note's editor (in Live Preview, the image itself) makes an image panel on the note's block that holds it, showing that image (for a block with several images, the one you dragged), at the image's proportions. The embed you dragged is the one used; if its place in the note cannot be told and the note embeds the image more than once, the first is used and a Notice says so.

Only text dragged out of a note's editor is matched to a place, and only against the editor the drag started in (in the main window or a popout window); text dragged in from another app or from Reading view is handled as any dropped text (links in it are linked, a path is resolved, anything else is ignored), and never writes into a note. A drop shows at most one Notice. If a block id has to be written and the note has just changed, so that Obsidian has not caught up with it, nothing is written and the Notice says `the note has changed; try again`: drop it again. Each drop is one undo step in the figure.

**Settings.** In Settings → Link Figures:

| Setting | Default | Meaning |
|---|---|---|
| Drop from a note | Block (adds a block id) | Block: as above. Heading: the block's id when it has one, otherwise the nearest heading above it (the whole note, with a Notice, when there is none); the note is never changed. Direct: no place in the note is linked: links in the dragged text are linked and an image's own file is linked, as before this setting. |
| Block id prefix | `fig` | New ids are this prefix, a dash and four letters or digits (`fig-3k9x`), not already in the note. Letters, digits and dashes only. |

A heading whose text occurs twice is linked through the headings above it (`#Results#Details`). Where that cannot tell it from an earlier one, Block mode links the first block of the selection by its id and Heading mode the whole note, with a Notice.

**Scripting.** Two additions, described with the others under Scripting:

| Call | What it does |
|---|---|
| `panel.create` (command) | Makes a panel linking `file` + `subpath`. Arguments (defaults in brackets): `file` (required; a note without `.md`, else the vault path), `subpath` (`""`), `show` (`"image"` or `"content"`; an image for an image, PDF or TIFF file, else content), `imageIndex` (whole number from 0), `x`, `y` (page px; required), `width`, `height` (page px above 0; the default size), `page` (the page in view, or required when the figure is closed), `id`. Result `{ id }`. It does not check that the link resolves: a link that leads nowhere makes a panel with a red badge. Drops use it. |
| `await api.blockId(notePath, line)` | The block id of the block that holds `line` (from 0) of the note, as `{ id, subpath }` (`subpath` is `#^id`): the id it has, or a new one written into the note (through its editor when it is open, else into the file). It writes whatever the "Drop from a note" setting says (even Heading or Direct), as it is a call you made. Calls on one note run one after another, each after Obsidian has indexed the last write (up to 2 s), so a script can give several blocks ids in a row. It rejects for a heading line (link a heading by its name), a line in no block, a block that cannot hold an id (front matter, a rule, HTML), a note that is not there and a note that has just changed. It is not a figure command, so it is not in `api.commands()`. |

```js
const api = app.plugins.plugins["link-figures"].api;
// A panel on the block at line 4 of a note.
const { subpath } = await api.blockId("Notes/Methods", 4);   // => { id: "fig-3k9x", subpath: "#^fig-3k9x" }
await api.run("Notes/My figure.lnkfig.md", "panel.create", { file: "Notes/Methods", subpath, x: 20, y: 20 });
// => { id: "p-aaaa" }
```

## PowerPoint

Format "PowerPoint (editable)" in the Export dialog (and `api.export(path, { format: "pptx" })`) writes `.pptx` files with one slide per page, the slide as large as the page and its background the page's paper colour.

**Editable in PowerPoint and Keynote:** rectangles, rounded rectangles and ellipses (solid, gradient and pattern fills, borders and dashes, rotation, opacity); text labels, as text boxes with the label's font, size, style, alignment and line spacing; connectors, as lines with arrowheads (they are not attached to the shapes they join, so moving a shape leaves the line where it was); PNG and JPEG image panels, as pictures (a cropped image is embedded already trimmed to what shows, so there is no hidden part to drag back out); frames, as the picture's outline; groups, as groups.

**Written as a picture** (at the export dpi, with a note in the export report): TIFF, SVG and PDF panels, content cards, images with a display adjustment, and anything a plugin draws that has no PowerPoint form. A bar cap on a connector is drawn without its cap, with a note, and a pattern fill's scale and angle are matched to the nearest PowerPoint pattern.

**Crops** are trimmed: a cropped PNG or JPEG is embedded as only the part that shows, with `srcRect` 0, and a crop reaching beyond the image keeps only the part inside it. The picture's hidden part is not in the file. (An image that could not be trimmed is embedded whole, with a warning.)

**Groups** stay groups when their members are next to each other in the stacking order; a group with another item between its members is written as separate items, with a note.

**One file per page size.** A figure whose pages differ in size gives one file per size: the size of the figure's first page gets `<figure>.pptx`, the others `<figure> (<width>×<height> mm).pptx`, whichever pages are exported, so a size always writes to the same file. A page larger than 1422.4 mm or smaller than 25.4 mm on a side is scaled to PowerPoint's limits, with a note.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Open figure files as figures | on | Open notes that carry the `link-figures` frontmatter key in the figure view. "Open as markdown" still shows the source. |
| Default page preset | Nature - double column | Page size of a new figure. |
| Attachment folder | empty | Folder for images dropped or pasted into a figure. Empty uses Obsidian's own attachment setting. |
| Export folder | empty | Folder for exported files. Empty saves them next to the figure. |
| Export resolution | 300 dpi | Dots per inch for what is drawn as pixels (the whole page in PNG and TIFF), from 72 to 1200. |
| Drop from a note | Block (adds a block id) | What a panel dragged out of a note's editor links to: Block, Heading or Direct. See Linking a place in a note. |
| Block id prefix | `fig` | The start of a block id written into a note. |

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

M2 is the editor: its first part (shapes and connectors, fills and paints, scripting) is in, as are alignment, crop, groups and PNG and TIFF export; PowerPoint export follows; M3 is presentation mode, figures embedded in notes, hover previews and the community plugin submission. The design, the file format and the milestones are in [docs/superpowers/specs/2026-10-27-link-figures-design.md](docs/superpowers/specs/2026-10-27-link-figures-design.md).

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

## Licence

MIT — see LICENSE.
