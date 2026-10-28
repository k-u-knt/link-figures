import { recipeOf } from "../adjust/render";
import { PANEL_EXTENSIONS, PDF_SCREEN_DPI } from "../constants";
import { joinLinktext, splitLinktext } from "../format/links-section";
import type { FileNode } from "../model/types";
import type { Decoders, FileRef, Resolved, SourceKind, VaultAccess } from "./types";

export function isPanelExtension(ext: string): boolean {
  return PANEL_EXTENSIONS.includes(ext.toLowerCase());
}

export function sourceKindOf(ext: string): SourceKind {
  switch (ext.toLowerCase()) {
    case "svg":
      return "svg";
    case "pdf":
      return "pdf";
    case "tif":
    case "tiff":
      return "tiff";
    default:
      return "raster";
  }
}

/** Drops an alias or size suffix (`|300`, `|label`) and surrounding whitespace from a linktext, then splits it into file and subpath. */
function splitWithoutAlias(linktext: string): { file: string; subpath: string } {
  const bar = linktext.indexOf("|");
  return splitLinktext((bar === -1 ? linktext : linktext.slice(0, bar)).trim());
}

function missing(reason: "file" | "subpath" | "no-image" | "decode", deps: string[]): Resolved {
  return { kind: "missing", reason, deps };
}

async function resolvePanel(
  file: FileRef,
  node: FileNode,
  access: VaultAccess,
  decoders: Decoders,
  deps: string[],
): Promise<Resolved> {
  const source = sourceKindOf(file.extension);
  // SVG ignores adjustments; a raster image without one that draws (on and registered) is shown by the browser straight
  // from the vault.
  if (source === "svg" || (source === "raster" && !decoders.adjusts(node))) {
    return { kind: "image", file, src: access.resourcePath(file), source, pageCount: 1, deps };
  }
  const bytes = await access.readBinary(file);
  try {
    const decoded =
      source === "pdf"
        ? await decoders.pdf(bytes, node.pageIndex, PDF_SCREEN_DPI / 72)
        : source === "tiff"
          ? await decoders.tiff(bytes, node.pageIndex, recipeOf(node))
          : await decoders.raster(bytes, recipeOf(node));
    return { kind: "image", file, src: decoded.dataUrl, source, pageCount: decoded.pageCount, deps };
  } catch (error) {
    return { kind: "missing", reason: "decode", deps, message: error instanceof Error ? error.message : String(error) };
  }
}

/** `figurePath` is the `.lnkfig.md` file the node lives in; the node's link is resolved relative to it. */
export async function resolveFileNode(
  node: FileNode,
  figurePath: string,
  access: VaultAccess,
  decoders: Decoders,
): Promise<Resolved> {
  const { file: linkPath, subpath } = splitWithoutAlias(joinLinktext(node.file, node.subpath));
  if (linkPath === "") return missing("file", []);

  const target = access.resolveLink(linkPath, figurePath);
  if (!target) return missing("file", []);
  if (isPanelExtension(target.extension)) return resolvePanel(target, node, access, decoders, [target.path]);

  if (target.extension.toLowerCase() !== "md") return missing("file", []);

  const deps = [target.path];
  const range = access.sectionRange(target, subpath);
  if (!range) return missing("subpath", deps);

  if (node.show === "content") {
    const text = await access.readText(target);
    return { kind: "content", file: target, markdown: text.slice(range.start, range.end ?? text.length), deps };
  }

  let seen = 0;
  for (const embed of access.embedsIn(target, range)) {
    const embedded = access.resolveLink(splitWithoutAlias(embed.link).file, target.path);
    if (!embedded || !isPanelExtension(embedded.extension)) continue;
    if (seen++ === node.imageIndex) return resolvePanel(embedded, node, access, decoders, [target.path, embedded.path]);
  }
  return missing("no-image", deps);
}

/**
 * For a file renamed from `oldPath` to `newPath`, the `file` a node in the figure at `figurePath` may have named it by
 * (its full path or any shorter tail of it, and for a note each without `.md`), mapped to what to name it by now. A
 * name counts only if it finds no file now: one that still does named that file before the rename as well, or (a
 * folder move) names the renamed file still. A full path stays a full path; a shorter name becomes `linktext`'s, which
 * is Obsidian's own linktext for the renamed file (without `.md` when asked to omit it).
 */
export function renamedLinkFiles(
  oldPath: string,
  newPath: string,
  figurePath: string,
  access: Pick<VaultAccess, "resolveLink">,
  linktext: (omitMdExtension: boolean) => string,
): Map<string, string> {
  const renames = new Map<string, string>();
  const isNote = /\.md$/i.test(oldPath);
  const parts = oldPath.split("/");
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.slice(i).join("/");
    const forms: [string, boolean][] = [[tail, false]];
    if (isNote) forms.push([tail.replace(/\.md$/i, ""), true]);
    for (const [name, omitMd] of forms) {
      if (renames.has(name) || access.resolveLink(name, figurePath) !== null) continue;
      renames.set(name, i > 0 ? linktext(omitMd) : omitMd ? newPath.replace(/\.md$/i, "") : newPath);
    }
  }
  return renames;
}
