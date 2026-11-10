import { prepareFuzzySearch, type App, type TFile } from "obsidian";
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
export type LinkSuggestApp = { vault: Pick<App["vault"], "getMarkdownFiles" | "getFiles">; metadataCache: Pick<App["metadataCache"], "getFirstLinkpathDest" | "fileToLinktext" | "getFileCache"> };

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

/** One entry of the list: what it shows, and the link text (without `[[`/`]]`) it inserts. */
interface Suggestion {
  title: string;
  note?: string;
  insert: string;
}

/** At most this many entries are listed, as Obsidian's suggesters limit theirs. */
const LIMIT = 100;

/** A heading as Obsidian writes it into a link: the characters a link cannot hold (`# | ^ : % [ ] \`) become spaces. */
export function headingLinktext(heading: string): string {
  return heading.replace(/[#|^:%[\]\\]/g, " ").replace(/\s+/g, " ").trim();
}

function fileSuggestions(app: LinkSuggestApp, sourcePath: string, q: LinkQuery): Suggestion[] {
  const files: TFile[] = q.embed ? app.vault.getFiles() : app.vault.getMarkdownFiles();
  const describe = (f: TFile): Suggestion => {
    const slash = f.path.lastIndexOf("/");
    return { title: f.extension === "md" ? f.basename : f.name, note: slash === -1 ? undefined : f.path.slice(0, slash), insert: app.metadataCache.fileToLinktext(f, sourcePath) };
  };
  const recent = (a: TFile, b: TFile) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0);
  if (q.query.trim() === "") return [...files].sort(recent).slice(0, LIMIT).map(describe);
  const search = prepareFuzzySearch(q.query.trim());
  const scored: { file: TFile; score: number }[] = [];
  for (const f of files) {
    const title = f.extension === "md" ? f.basename : f.name;
    const path = f.extension === "md" ? f.path.slice(0, -3) : f.path;
    const best = [search(title), search(path)].reduce<number | null>((s, r) => (r && (s === null || r.score > s) ? r.score : s), null);
    if (best !== null) scored.push({ file: f, score: best });
  }
  scored.sort((a, b) => b.score - a.score || recent(a.file, b.file));
  return scored.slice(0, LIMIT).map((s) => describe(s.file));
}

function sectionSuggestions(app: LinkSuggestApp, sourcePath: string, q: LinkQuery): Suggestion[] {
  if (q.target === "") return [];
  const file = app.metadataCache.getFirstLinkpathDest(q.target, sourcePath);
  if (!file) return [];
  const cache = app.metadataCache.getFileCache(file);
  const linktext = app.metadataCache.fileToLinktext(file, sourcePath);
  const entries: { text: string; suggestion: Suggestion }[] =
    q.kind === "heading"
      ? (cache?.headings ?? []).map((h) => ({ text: h.heading, suggestion: { title: h.heading, insert: `${linktext}#${headingLinktext(h.heading)}` } }))
      : Object.keys(cache?.blocks ?? {}).map((id) => ({ text: id, suggestion: { title: `^${id}`, insert: `${linktext}#^${id}` } }));
  if (q.query.trim() === "") return entries.slice(0, LIMIT).map((e) => e.suggestion);
  const search = prepareFuzzySearch(q.query.trim());
  return entries
    .map((e) => ({ e, r: search(e.text) }))
    .filter((x) => x.r !== null)
    .sort((a, b) => b.r!.score - a.r!.score)
    .slice(0, LIMIT)
    .map((x) => x.e.suggestion);
}

/** What the list offers for `q`; nothing when the app has no vault to read (a test's or a headless context). */
export function linkSuggestions(app: LinkSuggestApp, sourcePath: string, q: LinkQuery): Suggestion[] {
  if (!app?.vault || !app.metadataCache) return [];
  return q.kind === "file" ? fileSuggestions(app, sourcePath, q) : sectionSuggestions(app, sourcePath, q);
}

/** Text styles that decide where the characters of a textarea fall, copied onto the mirror that finds the caret. */
const MIRRORED = [
  "boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "paddingTop", "paddingRight",
  "paddingBottom", "paddingLeft", "fontFamily", "fontSize", "fontStyle", "fontWeight", "fontVariant", "letterSpacing", "lineHeight",
  "textTransform", "textIndent", "tabSize", "wordSpacing",
] as const;

/** Where the caret of `area` is on screen (the bottom left of its line), by laying the text out again in a hidden mirror. */
function caretPoint(area: HTMLTextAreaElement): { x: number; bottom: number; top: number } {
  const doc = area.ownerDocument;
  const view = doc.defaultView;
  const rect = area.getBoundingClientRect();
  const mirror = doc.createElement("div");
  const style = view?.getComputedStyle(area);
  if (style) for (const p of MIRRORED) mirror.style[p] = style[p];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden" });
  mirror.textContent = area.value.slice(0, area.selectionEnd);
  const mark = doc.createElement("span");
  mark.textContent = "​";
  mirror.appendChild(mark);
  doc.body.appendChild(mirror);
  const lineHeight = mark.offsetHeight || parseFloat(style?.lineHeight ?? "") || 16;
  const x = rect.left + mark.offsetLeft - area.scrollLeft;
  const top = rect.top + mark.offsetTop - area.scrollTop;
  mirror.remove();
  return { x, top, bottom: top + lineHeight };
}

/**
 * Offers link suggestions in `textarea` while a link is typed in it (see `linkQueryAt`), from `sourcePath` (the
 * figure's place in the vault, which link text is written from). The list is a `suggestion-container` on the document's
 * body at the caret. While it is open, ArrowUp/ArrowDown move through it, Enter or Tab accept, Escape closes it, and a
 * click accepts; these keys go no further (call this before adding the editor's own key handlers, so its Escape is not
 * reached). Accepting writes the link text after `[[` and the closing `]]` (one already there is not doubled). The list
 * closes on a blur and when the caret leaves the link. Returns the function that detaches it all.
 */
export function attachLinkSuggest(textarea: HTMLTextAreaElement, app: App | LinkSuggestApp, sourcePath: string): () => void {
  const doc = textarea.ownerDocument;
  let container: HTMLElement | null = null;
  let items: Suggestion[] = [];
  let selected = 0;
  let query: LinkQuery | null = null;

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

  const accept = (i: number) => {
    const q = query;
    const s = items[i];
    if (!q || !s) return;
    const text = textarea.value;
    // A `]]` already closing this link (typed, or the rest of a link being edited) is kept, not doubled.
    const after = /^[^[\]\n]*\]\]/.exec(text.slice(q.to));
    const end = after ? q.to + after[0].length : q.to;
    const value = `${text.slice(0, q.from)}${s.insert}]]${text.slice(end)}`;
    const caret = q.from + s.insert.length + 2;
    close();
    textarea.value = value;
    textarea.setSelectionRange(caret, caret);
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

  const update = () => {
    const q = linkQueryAt(textarea.value, textarea.selectionStart);
    const found = q && textarea.selectionStart === textarea.selectionEnd ? linkSuggestions(app as LinkSuggestApp, sourcePath, q) : [];
    if (!q || found.length === 0) return close();
    query = q;
    items = found;
    selected = 0;
    show();
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
  textarea.addEventListener("blur", close);
  return () => {
    close();
    textarea.removeEventListener("input", update);
    textarea.removeEventListener("click", update);
    textarea.removeEventListener("keydown", onKey);
    textarea.removeEventListener("keyup", onKeyUp);
    textarea.removeEventListener("blur", close);
  };
}
