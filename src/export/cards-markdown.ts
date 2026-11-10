import type { App } from "obsidian";
import { joinLinktext, splitLinktext } from "../format/links-section";
import { linkOf } from "../format/node-links";
import type { FileRef, VaultAccess } from "../links/types";
import { mmToPx, pageOriginsPx } from "../model/geometry";
import type { CardNode, Document, Node, NodeId, Page, PageId } from "../model/types";
import type { Registries } from "../registry";
import { exportDir, exportPathFor, safeFileName, uniqueFileNames, writeExportFile } from "./write";

/** Two cards whose tops are this close (mm) are one row; within a row they go left to right. */
export const CARD_ROW_MM = 5;

/** What separates two cards in a cards file. */
export const CARD_SEPARATOR = "\n\n---\n\n";

/**
 * The cards tied to page `page` by an association, in reading order: by the canvas position of their top-left corner,
 * rows first (tops within `CARD_ROW_MM` count as one row, which starts at its topmost card), then left to right. An
 * association is found through the type hooks: a node tied to the page (`tiedPages`) drawn from items that may be tied
 * to pages (`dependsOn` items whose type has `pageTies`), which only an association is (see `isAssociation`).
 */
export function cardsForPage(doc: Document, registries: Registries, page: PageId, unreadable?: ReadonlySet<NodeId>): CardNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const tied = new Set<NodeId>();
  for (const node of doc.nodes) {
    if (unreadable?.has(node.id)) continue;
    const type = registries.nodeTypes.get(node.type);
    if (!type?.tiedPages?.(node).includes(page)) continue;
    for (const id of type.dependsOn?.(node) ?? []) {
      const item = byId.get(id);
      if (item && !unreadable?.has(id) && registries.nodeTypes.get(item.type)?.pageTies) tied.add(id);
    }
  }
  const origins = pageOriginsPx(doc);
  const placed = [...tied].map((id) => {
    const node = byId.get(id)!;
    const origin = origins.get(node.page) ?? { x: 0, y: 0 };
    return { node, x: origin.x + node.x, y: origin.y + node.y };
  });
  placed.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: (typeof placed)[] = [];
  for (const card of placed) {
    const row = rows[rows.length - 1];
    if (row && card.y - row[0].y <= mmToPx(CARD_ROW_MM)) row.push(card);
    else rows.push([card]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x).map((card) => card.node as CardNode));
}

/** A card as messages name it: its name, else its id, quoted. */
const cardLabel = (card: Node) => JSON.stringify(typeof card.name === "string" && card.name.trim() !== "" ? card.name : card.id);

/** A note's section as a note card exports it: its raw Markdown, and the note's path, which its links resolve from. */
export interface NoteSection {
  markdown: string;
  path: string;
}

/** Leading YAML front matter, which only a whole note has. */
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;

/**
 * The section `subpath` (`""` the whole note, `#Heading`, `#^block`) of the note `file` links to from `fromPath`, as
 * the note has it now, read from the vault as content panels resolve theirs (the metadata cache's headings, blocks and
 * sections), so with the figure closed too. A whole note leaves its front matter out. Null when the link finds no note,
 * or the note has no such section.
 */
export async function readNoteSection(access: VaultAccess, file: string, subpath: string, fromPath: string): Promise<NoteSection | null> {
  const target = access.resolveLink(file, fromPath);
  if (!target || target.extension.toLowerCase() !== "md") return null;
  const range = access.sectionRange(target, subpath);
  if (!range) return null;
  const text = await access.readText(target);
  let markdown = text.slice(range.start, range.end ?? text.length);
  if (range.start === 0) markdown = markdown.replace(FRONT_MATTER, "");
  return { markdown: markdown.trim(), path: target.path };
}

/**
 * A card's Markdown as it is exported: a text card's text, or a note card's section (`deps.readNote`). `sourcePath` is
 * the note a note card's links resolve from (null for a text card: the figure's). A note card whose note or section
 * cannot be found gives no Markdown, and a warning; an empty card gives none, silently.
 */
export async function cardMarkdown(
  card: CardNode,
  deps: { readNote(file: string, subpath: string): Promise<NoteSection | null> },
): Promise<{ markdown: string | null; sourcePath: string | null; warnings: string[] }> {
  const link = linkOf(card);
  if (!link) {
    const text = (card.text ?? "").trim();
    return { markdown: text === "" ? null : text, sourcePath: null, warnings: [] };
  }
  const section = link.file === "" ? null : await deps.readNote(link.file, link.subpath);
  if (!section) {
    return { markdown: null, sourcePath: null, warnings: [`${cardLabel(card)}: its note "${joinLinktext(link.file, link.subpath)}" was not found; the card is left out`] };
  }
  return { markdown: section.markdown === "" ? null : section.markdown, sourcePath: section.path, warnings: [] };
}

/** An embed in Markdown: `![[x.png|300]]` or `![alt](x.png)`. */
const EMBED = /!\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\)/g;
/** A link with a scheme (`https:`, `data:`): not a vault file, and left as it is. */
const URL_LINK = /^[a-z][a-z0-9+.-]*:/i;
/** A wikilink alias that is an image size (`300`, `300x200`), not alt text. */
const SIZE_ALIAS = /^\d+(x\d+)?$/;

function decoded(link: string): string {
  try {
    return decodeURI(link);
  } catch {
    return link;
  }
}

/**
 * `markdown` with each embedded file (an image, or any other file that is not a note) copied (`deps.copy`, which gives
 * the relative path it was copied to) and its embed rewritten as a standard Markdown image with that path in angle
 * brackets: `![alt](<folder/name.png>)`, so the Markdown opens anywhere. What cannot be copied keeps its link, with a
 * warning naming the card (`deps.label`): a file not found, a note embedded, a copy that failed. Links with a scheme
 * (`https:`) are left as they are.
 */
export async function rewriteImages(
  markdown: string,
  deps: { label: string; resolve(link: string): FileRef | null; copy(file: FileRef): Promise<string | null> },
): Promise<{ markdown: string; warnings: string[] }> {
  const warnings: string[] = [];
  const parts: string[] = [];
  let last = 0;
  for (const m of markdown.matchAll(EMBED)) {
    parts.push(markdown.slice(last, m.index));
    last = m.index + m[0].length;
    let link: string;
    let alt: string;
    if (m[1] !== undefined) {
      const bar = m[1].indexOf("|");
      link = splitLinktext((bar === -1 ? m[1] : m[1].slice(0, bar)).trim()).file;
      const alias = bar === -1 ? "" : m[1].slice(bar + 1).trim();
      alt = SIZE_ALIAS.test(alias) ? "" : alias;
    } else {
      const dest = m[3].startsWith("<") ? m[3].slice(1, -1) : m[3];
      if (URL_LINK.test(dest)) {
        parts.push(m[0]);
        continue;
      }
      link = splitLinktext(decoded(dest)).file;
      alt = m[2];
    }
    const file = link === "" ? null : deps.resolve(link);
    if (!file) {
      warnings.push(`${deps.label}: the image "${link}" was not found; its link is kept`);
      parts.push(m[0]);
      continue;
    }
    if (file.extension.toLowerCase() === "md") {
      warnings.push(`${deps.label}: the embed "${link}" is not an image; its link is kept`);
      parts.push(m[0]);
      continue;
    }
    const copied = await deps.copy(file);
    if (copied === null) {
      warnings.push(`${deps.label}: the image "${link}" could not be copied; its link is kept`);
      parts.push(m[0]);
      continue;
    }
    parts.push(`![${alt}](<${copied}>)`);
  }
  parts.push(markdown.slice(last));
  return { markdown: parts.join(""), warnings };
}

/**
 * A `copy` for `rewriteImages` that copies into the folder `dirName` (beside the cards file): each source file once,
 * under its own name, made safe (`safeFileName`); a second file of the same name (compared ignoring case) becomes
 * `name-2.ext`, `name-3.ext`… `write(name, file)` does the copying, true when it was written. Gives `dirName/name`.
 */
export function imageCopier(dirName: string, write: (name: string, file: FileRef) => Promise<boolean>): (file: FileRef) => Promise<string | null> {
  const bySource = new Map<string, Promise<string | null>>();
  const used = new Set<string>();
  return (file) => {
    const known = bySource.get(file.path);
    if (known) return known;
    const base = safeFileName(file.path.slice(file.path.lastIndexOf("/") + 1));
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
    used.add(name.toLowerCase());
    const copied = write(name, file).then((ok) => (ok ? `${dirName}/${name}` : null));
    bySource.set(file.path, copied);
    return copied;
  };
}

/** A card's exported Markdown, with what its links resolve from. */
export interface CardText {
  card: CardNode;
  markdown: string;
  /** The vault path its links resolve from: its note, or the figure for a text card. */
  sourcePath: string;
}

/** What `cardTextSource` reads cards with. */
export interface CardTextContext {
  doc: Document;
  registries: Registries;
  figurePath: string;
  /** The vault; without it a note card cannot be read, and is left out with a warning. */
  access?: VaultAccess;
  unreadable?: ReadonlySet<NodeId>;
}

/**
 * Each page's cards (`cardsForPage`) with their Markdown (`cardMarkdown`), read once per page and once per card when
 * first asked for. Warnings go to `warnings`, once each.
 */
export function cardTextSource(ctx: CardTextContext, warnings: string[]): (page: PageId) => Promise<CardText[]> {
  const byCard = new Map<NodeId, Promise<CardText | null>>();
  const byPage = new Map<PageId, Promise<CardText[]>>();
  const read = (card: CardNode): Promise<CardText | null> => {
    let text = byCard.get(card.id);
    if (!text) {
      const readNote = (file: string, subpath: string) => (ctx.access ? readNoteSection(ctx.access, file, subpath, ctx.figurePath) : Promise.resolve(null));
      text = cardMarkdown(card, { readNote }).then((out) => {
        warnings.push(...out.warnings);
        return out.markdown === null ? null : { card, markdown: out.markdown, sourcePath: out.sourcePath ?? ctx.figurePath };
      });
      byCard.set(card.id, text);
    }
    return text;
  };
  return (page) => {
    let texts = byPage.get(page);
    if (!texts) {
      texts = (async () => {
        const out: CardText[] = [];
        for (const card of cardsForPage(ctx.doc, ctx.registries, page, ctx.unreadable)) {
          const text = await read(card);
          if (text) out.push(text);
        }
        return out;
      })();
      byPage.set(page, texts);
    }
    return texts;
  };
}

/** The cards file of a page: `<figure> - <page> cards.md`. */
export const cardsFileName = (baseName: string, page: Page): string => `${baseName} - ${page.name} cards.md`;

/**
 * Writes, for each page with cards, `<figure> - <page> cards.md` to `folder`: its cards' Markdown in order, separated by
 * `CARD_SEPARATOR`, with each embedded image copied into the folder `<figure> - <page> cards/` beside it and its link
 * rewritten (`rewriteImages`). Two pages of one name get distinct files (`uniqueFileNames`). Nothing is written over the
 * figure, its sources or a note a card was read from (`isProtected`), with a warning. Returns the vault paths written.
 */
export async function writeCardFiles(
  run: { pages: Page[]; baseName: string; folder: string; figurePath: string; texts: (page: PageId) => Promise<CardText[]> },
  deps: { app: App; access?: VaultAccess; isProtected: (path: string, cardsFile?: boolean) => boolean },
  warnings: string[],
): Promise<string[]> {
  const withCards: { page: Page; texts: CardText[] }[] = [];
  for (const page of run.pages) {
    const texts = await run.texts(page.id);
    if (texts.length > 0) withCards.push({ page, texts });
  }
  const names = uniqueFileNames(withCards.map(({ page }) => cardsFileName(run.baseName, page)));
  // The notes the cards were read from are sources too, whatever their name.
  const read = new Set(withCards.flatMap(({ texts }) => texts.map((t) => t.sourcePath)));
  const refused = (path: string, cardsFile: boolean) => {
    if (!deps.isProtected(path, cardsFile) && !read.has(path)) return false;
    warnings.push(`Refused to overwrite ${path}: it is a source of this figure`);
    return true;
  };
  const dir = exportDir(run.folder);
  const paths: string[] = [];

  for (const [i, { texts }] of withCards.entries()) {
    const name = names[i];
    const dirName = name.replace(/\.md$/, "");
    const imageFolder = dir ? `${dir}/${dirName}` : dirName;
    const copy = imageCopier(dirName, async (imageName, file) => {
      const path = exportPathFor(imageFolder, imageName);
      if (refused(path, false)) return false;
      try {
        const bytes = await deps.access!.readBinary(file);
        await writeExportFile(deps.app, imageFolder, imageName, new Blob([bytes]));
      } catch {
        return false;
      }
      paths.push(path);
      return true;
    });
    const parts: string[] = [];
    for (const text of texts) {
      const rewritten = await rewriteImages(text.markdown, {
        label: cardLabel(text.card),
        resolve: (link) => deps.access?.resolveLink(link, text.sourcePath) ?? null,
        copy,
      });
      warnings.push(...rewritten.warnings);
      parts.push(rewritten.markdown);
    }
    const path = exportPathFor(run.folder, name);
    if (refused(path, true)) continue;
    await writeExportFile(deps.app, run.folder, name, new Blob([`${parts.join(CARD_SEPARATOR)}\n`], { type: "text/markdown" }));
    paths.push(path);
  }
  return paths;
}
