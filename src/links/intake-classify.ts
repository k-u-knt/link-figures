import { splitLinktext } from "../format/links-section";
import { isPanelExtension } from "./resolver";

/** What a drop carried, read down to the fields that decide what to do with it. */
export interface DropData {
  /** Obsidian's own drag (`app.dragManager.draggable`): a file or folder of the vault, or a link. */
  draggable?: { type: "file" | "files" | "link" | "folder"; paths?: string[]; linktext?: string; sourcePath?: string };
  /** Files dragged in from the OS (`dataTransfer.files`), in the order they came. */
  osFiles?: { name: string; type: string }[];
  /** The drag's `text/plain`. */
  text?: string;
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
  | { kind: "save-image-blob"; index: number; name: string };

/** Lower-case extension after the last dot; none for a name without a dot or one that only starts with it (`.png`). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
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

function fromDraggable(draggable: NonNullable<DropData["draggable"]>): IntakeAction[] {
  switch (draggable.type) {
    case "file":
    case "files":
      return (draggable.paths ?? []).map((path) => ({ kind: "link-file", path }));
    case "link": {
      // A link that names no file (`#Heading`, inside the note it was dragged from) has nothing to link to here.
      const linktext = draggable.linktext?.trim() ?? "";
      if (splitLinktext(linktext).file.trim() === "") return [];
      const { sourcePath } = draggable;
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
  if (d.draggable) return fromDraggable(d.draggable);
  if (d.osFiles && d.osFiles.length > 0) {
    const out: IntakeAction[] = [];
    d.osFiles.forEach((file, index) => {
      if (isPanelExtension(extensionOf(file.name))) out.push({ kind: "save-file", index, name: file.name });
    });
    return out;
  }
  return wikilinksIn(d.text ?? "").map((linktext) => ({ kind: "link-text", linktext }));
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
