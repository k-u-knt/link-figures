import { FENCE_LANG, FRONTMATTER_KEY } from "../constants";
import { FormatError, NotFigureError } from "./errors";
import { parseLinksSection, type LinkEntry } from "./links-section";

export interface ParsedFigureFile {
  /** Raw frontmatter including both `---` fences and the trailing newline. */
  frontmatter: string;
  /** Everything between the frontmatter and `## Links` (or `## Figure` when there is no Links section). */
  preamble: string;
  links: LinkEntry[];
  /** The content of the `lnkfig` fence, or null when the file has none. */
  bodyJson: string | null;
  /** Everything after the closing fence. */
  trailing: string;
}

interface Line {
  text: string;
  /** Offset of the first character. */
  start: number;
  /** Offset just past the line's newline (or the end of the text). */
  end: number;
}

const MARKER_LINE = new RegExp(`^${FRONTMATTER_KEY}:`, "m");
const LINKS_HEADING = /^## Links[ \t]*$/;
const FIGURE_HEADING = /^## Figure[ \t]*$/;
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function toLines(s: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  while (pos < s.length) {
    const nl = s.indexOf("\n", pos);
    const end = nl === -1 ? s.length : nl + 1;
    lines.push({ text: s.slice(pos, nl === -1 ? s.length : nl), start: pos, end });
    pos = end;
  }
  return lines;
}

/** The fence marker and info string if `text` opens a fenced block. */
function openFence(text: string): { marker: string; info: string } | null {
  const m = OPEN_FENCE.exec(text);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null; // inline code, not a fence
  return { marker: m[1], info: m[2].trim() };
}

function closesFence(text: string, marker: string): boolean {
  const m = CLOSE_FENCE.exec(text);
  return !!m && m[1][0] === marker[0] && m[1].length >= marker.length;
}

/** Index of the line closing the fence opened at `lines[open]`, or -1. */
function findFenceEnd(lines: Line[], open: number, marker: string): number {
  for (let i = open + 1; i < lines.length; i++) if (closesFence(lines[i].text, marker)) return i;
  return -1;
}

/** Splits off a leading `---` frontmatter block, or returns null when there is none. `text` has `\n` line endings. */
function splitFrontmatter(text: string): { frontmatter: string; rest: string } | null {
  if (!text.startsWith("---\n")) return null;
  let pos = 4;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    if (/^---[ \t]*$/.test(text.slice(pos, nl === -1 ? text.length : nl))) return { frontmatter: text.slice(0, end), rest: text.slice(end) };
    pos = end;
  }
  return null;
}

const normalise = (text: string): string => text.replace(/\r\n/g, "\n");

export function isFigureText(text: string): boolean {
  const split = splitFrontmatter(normalise(text));
  return split !== null && MARKER_LINE.test(split.frontmatter);
}

/** Throws `NotFigureError` without the marker and `FormatError` for an unterminated `lnkfig` fence. */
export function parseFigureFile(text: string): ParsedFigureFile {
  const split = splitFrontmatter(normalise(text));
  if (!split || !MARKER_LINE.test(split.frontmatter)) throw new NotFigureError();
  const { frontmatter, rest } = split;
  const lines = toLines(rest);

  // Locate the section headings, ignoring anything inside fenced blocks.
  let linksAt = -1;
  let figureAt = -1;
  let fence: string | null = null;
  for (let i = 0; i < lines.length && figureAt === -1; i++) {
    const t = lines[i].text;
    if (fence !== null) {
      if (closesFence(t, fence)) fence = null;
      continue;
    }
    const open = openFence(t);
    if (open) fence = open.marker;
    else if (linksAt === -1 && LINKS_HEADING.test(t)) linksAt = i;
    else if (FIGURE_HEADING.test(t)) figureAt = i;
  }

  // An unclosed fence swallows the rest of the file, hiding the headings. Writing back would append a second
  // Links/Figure pair whose closing fence closes the user's, so refuse to read it instead.
  if (figureAt === -1 && fence !== null) throw new FormatError("A fenced code block is not closed, so the figure sections cannot be located");

  const firstHeading = linksAt !== -1 ? linksAt : figureAt;
  if (firstHeading === -1) return { frontmatter, preamble: rest, links: [], bodyJson: null, trailing: "" };

  const preamble = rest.slice(0, lines[firstHeading].start);
  const linksEnd = figureAt !== -1 ? lines[figureAt].start : rest.length;
  const links = linksAt !== -1 ? parseLinksSection(rest.slice(lines[linksAt].end, linksEnd)) : [];
  if (figureAt === -1) return { frontmatter, preamble, links, bodyJson: null, trailing: "" };

  // The body is the first `lnkfig` fence after the Figure heading.
  for (let i = figureAt + 1; i < lines.length; i++) {
    const open = openFence(lines[i].text);
    if (!open) continue;
    const close = findFenceEnd(lines, i, open.marker);
    if (open.info.split(/\s+/)[0] !== FENCE_LANG) {
      if (close === -1) break;
      i = close;
      continue;
    }
    if (close === -1) throw new FormatError(`The ${FENCE_LANG} block is not closed`);
    const bodyJson = rest.slice(lines[i].end, lines[close].start).replace(/\n$/, "");
    return { frontmatter, preamble, links, bodyJson, trailing: rest.slice(lines[close].end) };
  }
  return { frontmatter, preamble, links, bodyJson: null, trailing: rest.slice(lines[figureAt].end) };
}
