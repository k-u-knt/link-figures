import type { App } from "obsidian";
import { loadDocument } from "../format/load";
import { serializeFigureFile } from "../format/serialize";
import type { DocumentStore } from "../model/store";
import type { Node, NodeId } from "../model/types";
import { createFigureStore } from "../model/normalise";
import type { Registries } from "../registry";
import { nodeTypeFor, type LinkRename } from "../registry/node-type";
import { afterLinkUpdates } from "./link-updates";

/**
 * The names a link may have given the file at `oldPath` by (its full path or any shorter tail of it, and for a note
 * each without `.md`), lower-cased, as Obsidian matches them.
 */
function namesOf(oldPath: string): Set<string> {
  const names = new Set<string>();
  const parts = oldPath.split("/");
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.slice(i).join("/").toLowerCase();
    names.add(tail);
    if (/\.md$/i.test(tail)) names.add(tail.slice(0, -3));
  }
  return names;
}

/** The folder of a vault path ("" at the root). */
const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** `link` (`./x`, `../x`) joined to `folder` with its `.` and `..` parts resolved; null when it climbs above the vault. */
function joinRelative(folder: string, link: string): string | null {
  const parts = folder === "" ? [] : folder.split("/");
  for (const part of link.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * Which of two files a link that names both by name led to, as Obsidian picks: the one in the figure's own folder, else
 * the one with the shorter path, else `a` (the renamed file, which the link was written for).
 */
function pick(a: string, b: string, figureFolder: string): string {
  const here = (path: string) => folderOf(path) === figureFolder;
  if (here(a) !== here(b)) return here(a) ? a : b;
  const depth = (path: string) => path.split("/").length;
  return depth(b) < depth(a) ? b : a;
}

/**
 * The rename of the file at `oldPath` (now at `newPath`), as the figure at `figurePath` sees it once the file has its
 * new name; `linktext` is what links to it are written as now. `resolve` answers what a link target led to before the
 * rename, as Obsidian resolved it then, with the old file still there:
 * - a relative target (`./`, `../`) is joined to the figure's folder, and is the old file when it names its path;
 * - a target that is one of the old file's names (`namesOf`) led to it, unless another file it finds now (`resolveNow`)
 *   would have been picked over it (`pick`: one beside the figure, or with a shorter path); a target that finds the
 *   renamed file itself (a folder move) leads there, needing no rename;
 * - any other target leads where it finds now.
 */
export function linkRenameFor(
  oldPath: string,
  newPath: string,
  figurePath: string,
  linktext: string,
  resolveNow: (link: string, fromPath: string) => string | null,
): LinkRename {
  const names = namesOf(oldPath);
  const folder = folderOf(figurePath);
  const old = oldPath.toLowerCase();
  return {
    oldPath,
    linktext,
    resolve: (target) => {
      if (target.startsWith("./") || target.startsWith("../")) {
        const joined = joinRelative(folder, target)?.toLowerCase();
        if (joined === old || joined + ".md" === old) return oldPath;
        return resolveNow(target, figurePath);
      }
      const now = resolveNow(target, figurePath);
      if (!names.has(target.toLowerCase()) || now === newPath) return now;
      return now === null ? oldPath : pick(oldPath, now, folder);
    },
  };
}

/** `node` with its own links renamed by its type (`NodeType.renameLinks`), or itself; never a node its plugin could not read. */
function renamedNode(registries: Registries, unreadable: ReadonlySet<NodeId> | undefined, rename: LinkRename): (node: Node) => Node {
  return (node) => nodeTypeFor(registries, node, unreadable)?.renameLinks?.(node, rename) ?? node;
}

/**
 * Renames the links nodes hold in their own fields in an open figure's `store`: the document and its undo history
 * (`DocumentStore.rewriteNodes`), with no undo step of its own. True when the document changed, for the view to save.
 */
export function renameLinksInStore(store: DocumentStore, registries: Registries, rename: LinkRename): boolean {
  // Only a text that holds a link can hold one to the file: what history holds of other fields is not replayed.
  return store.rewriteNodes(renamedNode(registries, store.unreadable, rename), (value) => typeof value === "string" && value.includes("[["));
}

/**
 * The text of a figure file with the links its nodes hold in their own fields renamed; `text` itself (byte for byte)
 * when none changes. A text that does not load as a figure is given back as it is.
 */
export function renameLinksInFigureText(text: string, registries: Registries, rename: LinkRename): string {
  let loaded: ReturnType<typeof loadDocument>;
  try {
    loaded = loadDocument(text, registries);
  } catch {
    return text;
  }
  const store = createFigureStore(loaded.doc, registries, undefined, loaded.unreadable);
  const doc = store.doc;
  const nodes = doc.nodes.map(renamedNode(registries, store.unreadable, rename));
  if (nodes.every((n, i) => n === doc.nodes[i])) return text;
  const written = serializeFigureFile({ ...doc, nodes }, loaded.parsed);
  // Never a text that would not load back: the file keeps its old links rather than be damaged.
  try {
    loadDocument(written, registries);
  } catch {
    return text;
  }
  return written;
}

/** An open figure that takes a rename itself (its view, see `LinkFiguresView.renameLinks`). */
export interface OpenFigureLinks {
  renameLinks(rename: LinkRename): void;
}

/** What following renames into figures goes through: Obsidian's vault, the open views, and the figure files. */
export interface CardRenameHost {
  registries: Registries;
  /** The vault paths of the figure files. */
  figurePaths(): string[];
  /**
   * The open figure at `path` that takes the rename itself, `"held"` for one that is open but must not be written
   * (held after damage, or not readable), null when none is open with its figure loaded (the file is rewritten).
   */
  openFigure(path: string): OpenFigureLinks | "held" | null;
  read(path: string): Promise<string>;
  /** Reads, edits and writes the file as one step (`vault.process`); not through the link-update queue, which this runs in. */
  process(path: string, edit: (text: string) => string): Promise<void>;
  /** Obsidian's link text for the file at `newPath` from `figurePath` (`metadataCache.fileToLinktext`). */
  linktext(newPath: string, figurePath: string): string;
  /** The vault path `link` finds from `fromPath` now, or null. */
  resolve(link: string, fromPath: string): string | null;
}

/** The base name of `path` without its extension, lower-cased: every name a link may give the file by holds it. */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/**
 * Follows the rename of the file at `oldPath` (now at `newPath`) into the links figures' nodes hold in their own fields
 * (a text card's `[[…]]`), which Obsidian's updater cannot see: an open figure renames them in its store
 * (`OpenFigureLinks`); a closed one is rewritten with `process`, only when its text holds the file's base name at all
 * (a plain text search, so a figure that cannot hold a link to it is never parsed). A figure that fails is logged and
 * the others go on.
 */
export async function renameLinksInFigures(host: CardRenameHost, oldPath: string, newPath: string): Promise<void> {
  const stem = stemOf(oldPath);
  for (const path of host.figurePaths()) {
    if (path === newPath) continue;
    try {
      const rename = linkRenameFor(oldPath, newPath, path, host.linktext(newPath, path), host.resolve);
      const open = host.openFigure(path);
      if (open === "held") continue;
      if (open) {
        open.renameLinks(rename);
        continue;
      }
      const text = await host.read(path);
      if (!text.toLowerCase().includes(stem)) continue;
      await host.process(path, (now) => renameLinksInFigureText(now, host.registries, rename));
    } catch (error) {
      console.error(`Link Figures: could not follow the rename of "${oldPath}" into "${path}"`, error);
    }
  }
}

/**
 * The listener for the vault's `rename` event (`(file's new path, oldPath)`): each rename is followed into the figures
 * (`renameLinksInFigures`) after Obsidian's own link update for it, as a job of its update queue queued after that one
 * (`afterLinkUpdates` with `alwaysQueue`), so it neither writes between that update's collecting its offsets and
 * splicing its links in, nor sees a file before the update has rewritten it. Gives the promise of that job.
 */
export function followRenames(app: App, host: CardRenameHost): (newPath: string, oldPath: string) => Promise<void> {
  return (newPath, oldPath) =>
    afterLinkUpdates(app, () => renameLinksInFigures(host, oldPath, newPath), { alwaysQueue: true }).catch((error: unknown) => {
      console.error(`Link Figures: could not follow the rename of "${oldPath}"`, error);
    });
}
