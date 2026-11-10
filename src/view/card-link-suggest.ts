import { Notice, prepareFuzzySearch, stripHeadingForLink, type App, type TFile } from "obsidian";
import { isFigure } from "../format/figure-file";
import { blockAt, existingBlockId, idPlacement, type Block } from "../links/block-id";
import type { NoteCache } from "../links/note-block-id";
import { codeRanges } from "../model/card-links";

/**
 * Link suggestions while typing in a card's editor (a plain `textarea`), as Obsidian's link suggester offers them in a
 * note: `[[` lists notes (and, after `![[`, attachments too), `[[note#` its headings, `[[note^` or `[[note#^` its blocks.
 *
 * Obsidian's `AbstractInputSuggest` drives only an `<input>` or a contenteditable element and places its list under the
 * element, not at the caret, so this is a small popover of its own, in Obsidian's look (`suggestion-container`,
 * `suggestion-item`, `is-selected`). Notes are matched with Obsidian's own fuzzy search (`prepareFuzzySearch`), headings
 * and blocks come from the metadata cache, and what is inserted is Obsidian's link text for the file from the figure
 * (`fileToLinktext`).
 */

/** What the suggestions read from the app: the vault's files and the metadata cache. */
export type LinkSuggestApp = {
  vault: Pick<App["vault"], "getMarkdownFiles" | "getFiles" | "cachedRead">;
  metadataCache: Pick<App["metadataCache"], "getFirstLinkpathDest" | "fileToLinktext" | "getFileCache">;
  workspace?: Pick<App["workspace"], "getLastOpenFiles">;
};

/** Writes (or finds) the block id at `line` of the note at `path`: the drop-from-note machinery, `api.blockId`. */
export type BlockIdWriter = (path: string, line: number) => Promise<{ subpath: string }>;

/** What `attachLinkSuggest` may be given beyond the app: `blockId` lets it offer blocks that have no id yet. */
export interface LinkSuggestOptions {
  blockId?: BlockIdWriter;
}

/**
 * The link being typed at the caret: `from` is just after its `[[`, `to` the caret. `kind` says what is listed: files
 * (matching `query`, which is then the target typed so far), the headings or the blocks of `target` (matching `query`,
 * what follows the `#` or `^`).
 */
export interface LinkQuery {
  embed: boolean;
  from: number;
  to: number;
  kind: "file" | "heading" | "block";
  target: string;
  query: string;
}

/**
 * The link being typed at `caret` in `text`, or null: a `[[` earlier on the caret's line, not closed before the caret,
 * with no `[`, `]` or `|` (an alias) after it, and outside code (`codeRanges`), where `[[` is text, not a link.
 */
export function linkQueryAt(text: string, caret: number): LinkQuery | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const open = text.lastIndexOf("[[", caret - 2);
  if (open < lineStart) return null;
  const from = open + 2;
  const inner = text.slice(from, caret);
  if (/[[\]|]/.test(inner)) return null;
  if (codeRanges(text).some(([a, b]) => open >= a && open < b)) return null;
  const embed = open > 0 && text[open - 1] === "!";
  const hash = inner.indexOf("#");
  const hat = inner.indexOf("^");
  let q: Pick<LinkQuery, "kind" | "target" | "query">;
  if (hash !== -1 && (hat === -1 || hat > hash)) {
    const rest = inner.slice(hash + 1);
    q = rest.startsWith("^") ? { kind: "block", target: inner.slice(0, hash), query: rest.slice(1) } : { kind: "heading", target: inner.slice(0, hash), query: rest };
  } else if (hat !== -1) {
    q = { kind: "block", target: inner.slice(0, hat), query: inner.slice(hat + 1) };
  } else {
    q = { kind: "file", target: inner, query: inner };
  }
  return { embed, from, to: caret, ...q, target: q.target.trim() };
}

/**
 * One entry of the list: what it shows, and the link text (without `[[`/`]]`) it inserts, or, for a block that has no
 * id yet, the function that writes one into the note and gives the link text then.
 */
interface Suggestion {
  title: string;
  note?: string;
  insert: string | (() => Promise<string>);
}

/** At most this many entries are listed, as Obsidian's suggesters limit theirs. */
const LIMIT = 100;

/** The aliases in a note's front matter (`aliases` or `alias`, a list or one string), as `parseFrontMatterAliases` reads them. */
function aliasesOf(frontmatter: unknown): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const fm = frontmatter as Record<string, unknown>;
  const raw = fm.aliases ?? fm.alias;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return list.filter((a): a is string => typeof a === "string").map((a) => a.trim()).filter((a) => a !== "");
}

/** The best score `search` gives any of `texts`, or null when none matches. */
function bestScore(search: (text: string) => { score: number } | null, texts: string[]): number | null {
  let best: number | null = null;
  for (const t of texts) {
    const r = search(t);
    if (r && (best === null || r.score > best)) best = r.score;
  }
  return best;
}

function fileSuggestions(app: LinkSuggestApp, sourcePath: string, q: LinkQuery): Suggestion[] {
  const files: TFile[] = q.embed ? app.vault.getFiles() : app.vault.getMarkdownFiles();
  const titleOf = (f: TFile) => (f.extension === "md" ? f.basename : f.name);
  const describe = (f: TFile): Suggestion => {
    const slash = f.path.lastIndexOf("/");
    return { title: titleOf(f), note: slash === -1 ? undefined : f.path.slice(0, slash), insert: app.metadataCache.fileToLinktext(f, sourcePath) };
  };
  const recent = (a: TFile, b: TFile) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0);
  if (q.query.trim() === "") {
    // As Obsidian's: the files opened last first, in that order, then the rest by their last change.
    const lastOpen = app.workspace?.getLastOpenFiles?.() ?? [];
    const rank = new Map(lastOpen.map((path, i) => [path, i]));
    const opened = files.filter((f) => rank.has(f.path)).sort((a, b) => rank.get(a.path)! - rank.get(b.path)!);
    const rest = files.filter((f) => !rank.has(f.path)).sort(recent);
    return [...opened, ...rest].slice(0, LIMIT).map(describe);
  }
  const search = prepareFuzzySearch(q.query.trim());
  // Scored first; link text is made only for the entries listed (`fileToLinktext` is not free on a large vault).
  const scored: { file: TFile; score: number; alias: string | null }[] = [];
  for (const f of files) {
    const score = bestScore(search, [titleOf(f), f.extension === "md" ? f.path.slice(0, -3) : f.path]);
    if (score !== null) scored.push({ file: f, score, alias: null });
    if (f.extension !== "md") continue;
    // A note found by an alias is linked with the alias shown: `[[<linktext>|<alias>]]`.
    for (const alias of aliasesOf(app.metadataCache.getFileCache(f)?.frontmatter)) {
      const r = search(alias);
      if (r) scored.push({ file: f, score: r.score, alias });
    }
  }
  scored.sort((a, b) => b.score - a.score || recent(a.file, b.file));
  return scored.slice(0, LIMIT).map(({ file: f, alias }) => {
    if (alias === null) return describe(f);
    return { title: alias, note: f.path.slice(0, -3), insert: `${app.metadataCache.fileToLinktext(f, sourcePath)}|${alias}` };
  });
}

/** One line of a block as its preview shows it: without quote and list markers, a fence line, or an id at its end. */
function previewLine(line: string): string {
  let l = line.replace(/^\s*(>\s?)+/, "");
  if (/^\s*(`{3,}|~{3,})/.test(l)) return "";
  l = l.replace(/^\s*([-*+]|\d+[.)])\s+(\[.\]\s+)?/, "");
  return l.replace(/(^|\s)\^[A-Za-z0-9-]+\s*$/, "");
}

/** The one-line preview of lines `start`..`end` of `lines`. */
function preview(lines: readonly string[], start: number, end: number): string {
  const text = lines.slice(start, end + 1).map(previewLine).join(" ").replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * The blocks of a note that can be linked by an id, in its order: paragraphs, each list item, quotes, callouts, tables,
 * code and math (the sections `idPlacement` places an id for), with the id each has, if any.
 */
export function noteBlocks(cache: NoteCache): { block: Block; id: string | null }[] {
  const out: { block: Block; id: string | null }[] = [];
  for (const section of cache.sections ?? []) {
    const starts =
      section.type === "list"
        ? (cache.listItems ?? []).map((i) => i.position.start.line).filter((l) => l >= section.position.start.line && l <= section.position.end.line)
        : idPlacement(section.type) !== null
          ? [section.position.start.line]
          : [];
    for (const line of starts) {
      const block = blockAt(cache, line);
      if (block && idPlacement(block.type) !== null) out.push({ block, id: existingBlockId(cache.blocks, block) });
    }
  }
  return out;
}

async function blockSuggestions(app: LinkSuggestApp, file: TFile, linktext: string, q: LinkQuery, blockId: BlockIdWriter | undefined): Promise<Suggestion[]> {
  const cache = app.metadataCache.getFileCache(file) as NoteCache | null;
  if (!cache) return [];
  const lines = (await app.vault.cachedRead(file)).split(/\r?\n/);
  // A figure's text is the plugin's: an id is never written into it, so only its blocks that have one are offered.
  const writer = isFigure(file.path, cache.frontmatter) ? undefined : blockId;
  const giveId = async (line: number): Promise<string> => {
    try {
      return (await writer!(file.path, line)).subpath;
    } catch (error) {
      new Notice(`Link Figures: could not add a block id to "${file.path}": ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
  const entries = noteBlocks(cache)
    .filter(({ id }) => id !== null || writer !== undefined)
    .map(({ block, id }) => {
      const title = preview(lines, block.start, block.end);
      const insert = id !== null ? `${linktext}#^${id}` : async () => `${linktext}${await giveId(block.start)}`;
      return { texts: id ? [title, id] : [title], suggestion: { title, note: id ? `^${id}` : undefined, insert } as Suggestion };
    });
  if (q.query.trim() === "") return entries.slice(0, LIMIT).map((e) => e.suggestion);
  const search = prepareFuzzySearch(q.query.trim());
  return entries
    .map((e) => ({ e, score: bestScore(search, e.texts) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => b.score! - a.score!)
    .slice(0, LIMIT)
    .map((x) => x.e.suggestion);
}

function sectionSuggestions(app: LinkSuggestApp, sourcePath: string, q: LinkQuery, blockId: BlockIdWriter | undefined): Suggestion[] | Promise<Suggestion[]> {
  if (q.target === "") return [];
  const file = app.metadataCache.getFirstLinkpathDest(q.target, sourcePath);
  if (!file) return [];
  const linktext = app.metadataCache.fileToLinktext(file, sourcePath);
  if (q.kind === "block") return blockSuggestions(app, file, linktext, q, blockId);
  const entries = (app.metadataCache.getFileCache(file)?.headings ?? []).map((h) => ({ text: h.heading, suggestion: { title: h.heading, insert: `${linktext}#${stripHeadingForLink(h.heading)}` } }));
  if (q.query.trim() === "") return entries.slice(0, LIMIT).map((e) => e.suggestion);
  const search = prepareFuzzySearch(q.query.trim());
  return entries
    .map((e) => ({ e, r: search(e.text) }))
    .filter((x) => x.r !== null)
    .sort((a, b) => b.r!.score - a.r!.score)
    .slice(0, LIMIT)
    .map((x) => x.e.suggestion);
}

/**
 * What the list offers for `q` (blocks after reading the note, so as a promise); nothing when the app has no vault to
 * read (a test's or a headless context).
 */
export function linkSuggestions(app: LinkSuggestApp, sourcePath: string, q: LinkQuery, blockId?: BlockIdWriter): Suggestion[] | Promise<Suggestion[]> {
  if (!app?.vault || !app.metadataCache) return [];
  return q.kind === "file" ? fileSuggestions(app, sourcePath, q) : sectionSuggestions(app, sourcePath, q, blockId);
}

/** Text styles that decide where the characters of a textarea fall, copied onto the mirror that finds the caret. */
const MIRRORED = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontFamily", "fontSize", "fontStyle", "fontWeight", "fontVariant",
  "letterSpacing", "lineHeight", "textTransform", "textIndent", "tabSize", "wordSpacing",
] as const;

/**
 * Where the caret of `area` is on screen (its line's top and bottom, and its left), by laying the text out again in a
 * hidden mirror. The mirror has the textarea's own width inside its borders (`clientWidth`) and no borders, so the text
 * wraps as it does there. The textarea may be drawn scaled (the canvas's zoom is a CSS scale on the viewport): the
 * offsets, measured unscaled, are scaled by its drawn width over its own (`rect.width / offsetWidth`).
 */
function caretPoint(area: HTMLTextAreaElement): { x: number; bottom: number; top: number } {
  const doc = area.ownerDocument;
  const view = doc.defaultView;
  const rect = area.getBoundingClientRect();
  const scale = area.offsetWidth > 0 && rect.width > 0 ? rect.width / area.offsetWidth : 1;
  const mirror = doc.createElement("div");
  const style = view?.getComputedStyle(area);
  if (style) for (const p of MIRRORED) mirror.style[p] = style[p];
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", top: "0", left: "-9999px", boxSizing: "border-box", border: "0",
    width: `${area.clientWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden",
  });
  mirror.textContent = area.value.slice(0, area.selectionEnd);
  const mark = doc.createElement("span");
  mark.textContent = "\u200b";
  mirror.appendChild(mark);
  doc.body.appendChild(mirror);
  const left = mark.offsetLeft;
  const lineHeight = mark.offsetHeight || parseFloat(style?.lineHeight ?? "") || 16;
  const x = rect.left + (area.clientLeft + left - area.scrollLeft) * scale;
  const top = rect.top + (area.clientTop + mark.offsetTop - area.scrollTop) * scale;
  mirror.remove();
  return { x, top, bottom: top + lineHeight * scale };
}

/**
 * Offers link suggestions in `textarea` while a link is typed in it (see `linkQueryAt`), from `sourcePath` (the
 * figure's place in the vault, which link text is written from). The list is a `suggestion-container` on the document's
 * body at the caret. While it is open, ArrowUp/ArrowDown move through it, Enter or Tab accept, Escape closes it, and a
 * click accepts; these keys go no further (call this before adding the editor's own key handlers, so its Escape is not
 * reached). Accepting writes the link text after `[[` and the closing `]]` (one already there is not doubled). The list
 * closes on a blur and when the caret leaves the link. With `options.blockId`, a block that has no id is offered too:
 * choosing it writes an id into the note through it (an undo in the card leaves that id in the note), then inserts the
 * link. Returns the function that detaches it all.
 */
export function attachLinkSuggest(textarea: HTMLTextAreaElement, app: App | LinkSuggestApp, sourcePath: string, options: LinkSuggestOptions = {}): () => void {
  const doc = textarea.ownerDocument;
  let container: HTMLElement | null = null;
  let items: Suggestion[] = [];
  let selected = 0;
  let query: LinkQuery | null = null;
  let detached = false;

  const close = () => {
    container?.remove();
    container = null;
    items = [];
    query = null;
  };

  const select = (i: number) => {
    if (!container || items.length === 0) return;
    selected = (i + items.length) % items.length;
    container.querySelectorAll(".suggestion-item").forEach((el, j) => {
      el.classList.toggle("is-selected", j === selected);
      if (j === selected) (el as HTMLElement).scrollIntoView?.({ block: "nearest" });
    });
  };

  /**
   * Writes `insert` in place of what was typed after `[[` (from `from` to the caret `to`), with the caret after the
   * link's `]]`. When the caret is inside a link already closed, the rest of the part being typed (the target, or the
   * `#subpath`) is replaced too, and an `|alias` or `#subpath` after it is kept, as is the `]]`; an alias suggestion
   * then keeps the alias written. Otherwise `]]` is added. The text goes in as the user's typing would
   * (`insertText`), so the textarea's own undo takes it back; written directly when that command does nothing.
   */
  const write = (q: LinkQuery, insert: string) => {
    const text = textarea.value;
    const rest = text.slice(q.to);
    const part = (q.kind === "file" ? /^[^[\]|#\n]*/ : /^[^[\]|\n]*/).exec(rest)![0];
    const next = rest.slice(part.length);
    const closed = /^(\]\]|[|#][^[\]\n]*\]\])/.test(next) && !(q.kind !== "file" && next.startsWith("#"));
    let inserted = insert;
    if (closed && next.startsWith("|") && inserted.includes("|")) inserted = inserted.slice(0, inserted.indexOf("|"));
    if (!closed) inserted += "]]";
    const end = closed ? q.to + part.length : q.to;
    textarea.setSelectionRange(q.from, end);
    const exec = (doc as Document & { execCommand?: (command: string, ui?: boolean, value?: string) => boolean }).execCommand;
    const done = typeof exec === "function" && exec.call(doc, "insertText", false, inserted) && textarea.value === text.slice(0, q.from) + inserted + text.slice(end);
    if (!done) textarea.value = text.slice(0, q.from) + inserted + text.slice(end);
    const caret = textarea.value.indexOf("]]", q.from + inserted.length - 2) + 2;
    textarea.setSelectionRange(caret, caret);
  };

  const accept = (i: number) => {
    const q = query;
    const s = items[i];
    if (!q || !s) return;
    close();
    if (typeof s.insert === "string") return write(q, s.insert);
    // A block with no id: one is written into the note first. The link goes in once it is, if what was typed is
    // still there as it was (the edit may have ended, or the text changed, meanwhile).
    const typed = textarea.value.slice(q.from, q.to);
    s.insert().then(
      (insert) => {
        if (!detached && textarea.isConnected && textarea.value.slice(q.from, q.to) === typed) write(q, insert);
      },
      // Told to the user with a Notice where the id was to be written (`blockSuggestions`).
      (error: unknown) => console.error("Link Figures: could not give the block an id", error),
    );
  };

  const show = () => {
    if (!container) {
      container = doc.body.createDiv({ cls: ["suggestion-container", "lf-link-suggest"] });
      // A press on the list must not take the focus from the editor (a blur would end the edit).
      container.addEventListener("mousedown", (ev) => ev.preventDefault());
    }
    container.empty();
    const list = container.createDiv({ cls: "suggestion" });
    items.forEach((s, i) => {
      const item = list.createDiv({ cls: "suggestion-item" });
      const content = item.createDiv({ cls: "suggestion-content" });
      content.createDiv({ cls: "suggestion-title", text: s.title });
      if (s.note) content.createDiv({ cls: "suggestion-note", text: s.note });
      item.addEventListener("mousemove", () => {
        if (selected !== i) select(i);
      });
      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        accept(i);
        textarea.focus({ preventScroll: true });
      });
    });
    select(0);
    place();
  };

  const place = () => {
    if (!container) return;
    const at = caretPoint(textarea);
    const win = doc.defaultView;
    const height = container.offsetHeight;
    const below = !win || at.bottom + height <= win.innerHeight || at.top - height < 0;
    container.style.position = "fixed";
    container.style.left = `${Math.max(0, at.x)}px`;
    container.style.top = `${below ? at.bottom : at.top - height}px`;
  };

  /** Counts the updates, so a list read late (a note's blocks) is shown only when nothing was typed since. */
  let seq = 0;
  const update = () => {
    const ask = ++seq;
    const q = linkQueryAt(textarea.value, textarea.selectionStart);
    const found = q && textarea.selectionStart === textarea.selectionEnd ? linkSuggestions(app as LinkSuggestApp, sourcePath, q, options.blockId) : [];
    const apply = (list: Suggestion[]) => {
      if (ask !== seq || detached) return;
      if (!q || list.length === 0) return close();
      query = q;
      items = list;
      selected = 0;
      show();
    };
    if (Array.isArray(found)) return apply(found);
    found.then(apply, (error: unknown) => {
      console.error("Link Figures: could not list the note's blocks", error);
      if (ask === seq) close();
    });
  };

  const onKey = (ev: KeyboardEvent) => {
    if (!container || ev.isComposing) return;
    switch (ev.key) {
      case "ArrowDown":
        select(selected + 1);
        break;
      case "ArrowUp":
        select(selected - 1);
        break;
      case "Enter":
      case "Tab":
        if (ev.shiftKey || ev.altKey || ev.metaKey || ev.ctrlKey) return;
        accept(selected);
        break;
      case "Escape":
        close();
        break;
      default:
        return;
    }
    // The list's keys are its own: not the editor's (Escape would end the edit), nor the stage's.
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  // A caret moved without typing (arrows across the text, a click in it) may leave the link, or enter one.
  const onKeyUp = (ev: KeyboardEvent) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) update();
  };

  textarea.addEventListener("input", update);
  textarea.addEventListener("click", update);
  textarea.addEventListener("keydown", onKey);
  textarea.addEventListener("keyup", onKeyUp);
  // A blur closes the list, and drops any list still being read.
  const onBlur = () => {
    seq++;
    close();
  };
  textarea.addEventListener("blur", onBlur);
  // The list stays at the caret: as the textarea scrolls, and the window is resized.
  const onScroll = () => place();
  textarea.addEventListener("scroll", onScroll);
  const win = doc.defaultView;
  win?.addEventListener("resize", onScroll);
  // A wheel anywhere but over the list (the canvas zooming or panning) moves the textarea away: the list closes. One over
  // the textarea scrolls it, and the list follows (`onScroll`).
  const onWheel = (ev: WheelEvent) => {
    const over = (el: Node | null) => !!el && !!ev.target && el.contains(ev.target as Node);
    if (container && !over(container) && !over(textarea)) onBlur();
  };
  doc.addEventListener("wheel", onWheel, { capture: true });
  return () => {
    textarea.removeEventListener("scroll", onScroll);
    win?.removeEventListener("resize", onScroll);
    doc.removeEventListener("wheel", onWheel, { capture: true });
    detached = true;
    seq++;
    close();
    textarea.removeEventListener("input", update);
    textarea.removeEventListener("click", update);
    textarea.removeEventListener("keydown", onKey);
    textarea.removeEventListener("keyup", onKeyUp);
    textarea.removeEventListener("blur", onBlur);
  };
}
