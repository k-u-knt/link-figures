import { FILE_SUFFIX } from "../constants";
import { splitLinktext } from "../format/links-section";
import type { DropFromNote } from "../settings/settings";
import { isPanelExtension, sourceKindOf } from "./resolver";

/** An open note whose editor has the dropped text selected: its path, and the selection's first and last lines (0-based). */
export interface SelectionMatch {
  path: string;
  from: number;
  to: number;
}

/** What a drop carried, read down to the fields that decide what to do with it. */
export interface DropData {
  /** Obsidian's own drag (`app.dragManager.draggable`): a file or folder of the vault, or a link. */
  draggable?: { type: "file" | "files" | "link" | "folder"; paths?: string[]; linktext?: string; sourcePath?: string };
  /** Files dragged in from the OS (`dataTransfer.files`), in the order they came. */
  osFiles?: { name: string; type: string }[];
  /** The drag's `text/plain`. */
  text?: string;
  /**
   * The `dropFromNote` setting. Without it, a drop out of a note is read as it was before the setting (`"direct"`):
   * text by its links or as a path, an image link as the image's file.
   */
  fromNote?: DropFromNote;
  /** The open note whose editor has `text` selected (the most recently active first), or null; asked only when `fromNote` is not `"direct"`. */
  selection?: (text: string) => SelectionMatch | null;
  /**
   * When the drag started on an embed in a note's editor (`EditorDragTracker.embed`): that note, and the embed's line
   * and offset in it when the editor could say. Live Preview drags an inline embedded image as its `file`, and an
   * own-line one as a `link` from the note.
   */
  embedDrag?: { sourcePath: string; line: number | null; offset?: number | null };
}

export type IntakeAction =
  /** A vault file by path: shown as an image or as note content, by its extension. */
  | { kind: "link-file"; path: string }
  /**
   * A pasted or dropped `![[…]]` or `[[…]]`, without its alias. A link dragged out of a note carries that note's path
   * as `sourcePath`: the linktext is relative to it, not to the figure.
   */
  | { kind: "link-text"; linktext: string; sourcePath?: string }
  /** The OS file at `osFiles[index]`, to be copied into the vault. */
  | { kind: "save-file"; index: number; name: string }
  /** The clipboard image at item `index`, to be saved under `name`. */
  | { kind: "save-image-blob"; index: number; name: string }
  /**
   * Text dragged out of a note's editor (its selection, lines `from`..`to`, 0-based): one panel linking the block that
   * holds it, or the heading section over the blocks it spans (`note-drop.ts`).
   */
  | { kind: "link-block"; notePath: string; from: number; to: number }
  /**
   * An image link dragged out of the note `sourcePath` (an embed in it): a panel of the note's block or section that
   * shows that image. `line` (and `offset`), when known, is where the dragged embed is in the note.
   */
  | { kind: "link-note-image"; linktext: string; sourcePath: string; line?: number; offset?: number }
  /**
   * One line of dropped text with no wikilink in it: a vault file if it resolves as a path, else nothing. Without
   * Obsidian's drag object (`app.dragManager` is unofficial) a file dragged from the vault arrives as such text.
   */
  | { kind: "maybe-path"; text: string };

/** Lower-case extension after the last dot; none for a name without a dot or one that only starts with it (`.png`). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether the file at `path` is a vector source (SVG or PDF): a panel of it has no samples to display. */
export function isVectorFile(path: string): boolean {
  const kind = sourceKindOf(extensionOf(path));
  return kind === "svg" || kind === "pdf";
}

/** `[[…]]` and `![[…]]`, on one line. */
const WIKILINK = /!?\[\[([^\[\]\r\n]*)\]\]/g;

/** The linktexts of the wikilinks in `text`, with alias or size (`|…`) removed. A link that names no file (`[[#Heading]]`) is not one. */
function wikilinksIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const bar = match[1].indexOf("|");
    const linktext = (bar === -1 ? match[1] : match[1].slice(0, bar)).trim();
    if (splitLinktext(linktext).file.trim() !== "") out.push(linktext);
  }
  return out;
}

/**
 * A Markdown link or embed, `[text](target)` or `![alt](target)`, on one line; the target may be in `<…>`, and a title
 * after it must follow white space, as in CommonMark. The text holds no `[` and the title none either, so each `[` and
 * each target is read once at most: a line of many `[` before a `](` with no `)` is read in linear time (it used to
 * take time cubic in it).
 */
export const MD_LINK = /!?\[[^[\]\r\n]*\]\(\s*(<[^>\r\n]*>|[^)\s]+)(?:\s[^)[\r\n]*)?\)/g;

/** The target of a Markdown link as written in its `(…)`, without `<>` and percent-escapes. */
export function mdLinkTarget(raw: string): string {
  const target = raw.replace(/^<|>$/g, "");
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

/** The vault targets of the Markdown links in `text`, with where each is: a web or other URL (`scheme:`) names no vault file. */
function mdLinksIn(text: string): { linktext: string; at: number }[] {
  return [...text.matchAll(MD_LINK)]
    .map((m) => ({ linktext: mdLinkTarget(m[1]), at: m.index ?? 0 }))
    .filter(({ linktext }) => linktext.trim() !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(linktext));
}

/** The linktexts of the wikilinks and the Markdown links in `text`, in the order they are written. */
function linksInOrder(text: string): string[] {
  const wiki = [...text.matchAll(WIKILINK)].flatMap((m) => wikilinksIn(m[0]).map((linktext) => ({ linktext, at: m.index ?? 0 })));
  return [...wiki, ...mdLinksIn(text)].sort((a, b) => a.at - b.at).map((l) => l.linktext);
}

/** Whether `text` is links and embeds only (wikilinks and Markdown ones), with nothing but white space between them. */
function onlyLinks(text: string): boolean {
  // `match`, not `test`: the expressions are global, and `test` would keep its place for the next call.
  const rest = text.replace(WIKILINK, "").replace(MD_LINK, "");
  return (text.match(WIKILINK) !== null || text.match(MD_LINK) !== null) && rest.trim() === "";
}

/** Whether a drop out of a note is to be linked to the note (its block or section), by the setting. */
const linksToNote = (fromNote: DropFromNote | undefined) => fromNote === "block-id" || fromNote === "heading";

/** Whether `path` is a note's, and not a figure's (a figure is not a note). */
const isNotePath = (path: string) => /\.md$/i.test(path) && !path.endsWith(FILE_SUFFIX);

/** The embed's line, and its offset when the line is known, as a `link-note-image` takes them: none when the line is unknown. */
function embedPlace({ line, offset }: NonNullable<DropData["embedDrag"]>): { line?: number; offset?: number } {
  if (line === null) return {};
  return typeof offset === "number" ? { line, offset } : { line };
}

function fromDraggable(draggable: NonNullable<DropData["draggable"]>, fromNote: DropFromNote | undefined, embedDrag: DropData["embedDrag"]): IntakeAction[] {
  switch (draggable.type) {
    case "file":
    case "files": {
      const paths = draggable.paths ?? [];
      // One image file dragged off an embed in a note's editor (Live Preview's image widget): the place in the note, by the setting.
      if (draggable.type === "file" && paths.length === 1 && embedDrag && isNotePath(embedDrag.sourcePath) && linksToNote(fromNote) && isPanelExtension(extensionOf(paths[0]))) {
        return [{ kind: "link-note-image", linktext: paths[0], sourcePath: embedDrag.sourcePath, ...embedPlace(embedDrag) }];
      }
      return paths.map((path) => ({ kind: "link-file", path }));
    }
    case "link": {
      // A link that names no file (`#Heading`, inside the note it was dragged from) has nothing to link to here.
      const linktext = draggable.linktext?.trim() ?? "";
      if (splitLinktext(linktext).file.trim() === "") return [];
      const { sourcePath } = draggable;
      // An image dragged out of a note (an embed in it) links the place in the note, by the setting; a figure is not a note.
      const fromANote = sourcePath !== undefined && isNotePath(sourcePath);
      if (fromANote && linksToNote(fromNote) && isPanelExtension(extensionOf(splitLinktext(linktext).file))) {
        // Live Preview drags an own-line embed as a link: the place recorded at dragstart, when it was in this note's editor.
        const place = embedDrag && embedDrag.sourcePath === sourcePath ? embedPlace(embedDrag) : {};
        return [{ kind: "link-note-image", linktext, sourcePath, ...place }];
      }
      return [sourcePath === undefined ? { kind: "link-text", linktext } : { kind: "link-text", linktext, sourcePath }];
    }
    default:
      return [];
  }
}

/**
 * What to do with a drop. An Obsidian drag wins over the text that travels with it, and files from the OS win over
 * text: whichever source is present decides, so one drop never counts twice. OS files are accepted only when
 * their extension is one a panel can show; the caller names the ones left out.
 */
export function classifyDrop(d: DropData): IntakeAction[] {
  if (d.draggable) return fromDraggable(d.draggable, d.fromNote, d.embedDrag);
  if (d.osFiles && d.osFiles.length > 0) {
    const out: IntakeAction[] = [];
    d.osFiles.forEach((file, index) => {
      if (isPanelExtension(extensionOf(file.name))) out.push({ kind: "save-file", index, name: file.name });
    });
    return out;
  }
  const text = d.text ?? "";
  // Text selected in an open note's editor links the place it came from, unless it is links only (each is linked, from that note).
  const match = linksToNote(d.fromNote) && d.selection && text.trim() !== "" ? d.selection(text) : null;
  if (match) {
    if (onlyLinks(text)) return linksInOrder(text).map((linktext) => ({ kind: "link-text", linktext, sourcePath: match.path }));
    return [{ kind: "link-block", notePath: match.path, from: match.from, to: match.to }];
  }
  // Text with a wikilink in it is read for its links only, even when none of them names a file.
  if (text.match(WIKILINK)) return wikilinksIn(text).map((linktext) => ({ kind: "link-text", linktext }));
  const line = text.trim();
  return line !== "" && !/[\r\n]/.test(line) ? [{ kind: "maybe-path", text: line }] : [];
}

const IMAGE_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/tiff": "tif",
};

const two = (n: number): string => String(n).padStart(2, "0");

/** `Pasted image YYYYMMDDHHmmss.<ext>` in local time, which is how Obsidian names a pasted image. */
function pastedImageName(now: Date, extension: string): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `Pasted image ${stamp}.${extension}`;
}

/**
 * What to do with a paste. `items` are the clipboard's items in order (`text` is given for the plain-text one) and
 * `index` in an action is a position in that list. An image type the plugin cannot show is left out.
 */
export function classifyPaste(items: { type: string; text?: string }[], now: Date): IntakeAction[] {
  const out: IntakeAction[] = [];
  items.forEach((item, index) => {
    const type = item.type.split(";")[0].trim().toLowerCase();
    const extension = IMAGE_TYPE_EXTENSIONS[type];
    if (extension) out.push({ kind: "save-image-blob", index, name: pastedImageName(now, extension) });
    else if (type === "text/plain" && item.text) for (const linktext of wikilinksIn(item.text)) out.push({ kind: "link-text", linktext });
  });
  return out;
}

/** What a link cannot hold in a file name: `#` and `^` start a subpath, `[` `]` end the link, `|` starts its alias. */
const LINK_BREAKING = /-*[#^[\]|][#^[\]|-]*/g;

/**
 * `name` with each run of `#`, `^`, `[`, `]` and `|` (and the dashes next to it) replaced by one "-", as Obsidian's own
 * paste handler does: a saved file must be linkable, and a link to `plot #3.png` would read as `plot ` and a heading.
 */
export function linkSafeName(name: string): string {
  return name.replace(LINK_BREAKING, "-");
}

/** `name` if no file has it, else `name 1`, `name 2`… (before the extension) until one is free. `exists` is asked about bare names. */
export function dedupeName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const extension = dot <= 0 ? "" : name.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem} ${n}${extension}`;
    if (!exists(candidate)) return candidate;
  }
}
