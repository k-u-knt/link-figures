import type { App, TFile } from "obsidian";

/**
 * Obsidian's own note embed, editable, as Canvas makes it for a file card: the one place this plugin touches Obsidian's
 * internal embed registry (`app.embedRegistry`, not in Obsidian's typings). Every member used is checked at run time, so
 * a change in Obsidian shows here, as `openEmbed` giving null with one warning, and nowhere else.
 *
 * As Obsidian 1.15 has it: `ya.load(ctx)` resolves the file and calls `embedRegistry.getEmbedCreator(file)(ctx, file,
 * subpath)`; Canvas's file node then sets `editable`, `useIframe` and `requestEdit`, loads it and calls `loadFile()`.
 * The Markdown embed shows its editor with `showEditor(evt)` (in an iframe, which takes the stage's zoom into account
 * when it places the caret) and goes back to the preview with `showPreview(save)`; `editMode` is the open editor, whose
 * `register` callbacks run when it goes. Typing saves through a debounced `requestSave`, whose `run()` saves now;
 * `savePromise` is a write under way. A heading or block subpath edits only that section (checked in Obsidian: the
 * embed splits the note into `before`, `heading`, its text and `after`, and writes them back together).
 *
 * Where the caret goes: `showEditor(evt)` places it with CodeMirror's `posAtCoords` at the click, in the editor's own
 * layout, which is not the rendered view's: Live Preview gives each blank line between paragraphs a whole line where the
 * reading view has a paragraph margin, and draws headings taller, so the editor's text sits lower than the rendered text
 * did, more so further down (two lines, 46px, by the third paragraph), and the caret landed lines above the click.
 * Instead, the clicked character is found in the rendering (`caretRangeFromPoint`), in its section of the reading view
 * (`previewMode.renderer.sections`: each block's element and its offsets in the embed's `text`, which is what the
 * editor holds), and traced back into the Markdown (`sourceOffset`); the editor is opened without the point, the caret
 * put there (`editMode.editor`), and the editor scrolled so the clicked line stays where it was clicked, as far as it
 * can. Any of that missing, the point goes to `showEditor` as before.
 */
export interface LiveEmbed {
  /** Opens the editor, with the caret at `at` (client px) when given. Nothing when `canEdit` says no. */
  edit(at?: { x: number; y: number }): void;
  /** Ends the edit, saving what was typed, and shows the rendered note again. Nothing when not editing. */
  stopEditing(): void;
  editing(): boolean;
  /**
   * Writes a save that is waiting (typing is saved a moment later), and waits for any write under way. True when the
   * note was (or was being) written.
   */
  flush(): Promise<boolean>;
  /** Ends any edit (with a save) and unloads the embed. Once. */
  unload(): void;
  /** Settles once the note has been read into the embed, or failed to be. Never rejects. */
  ready: Promise<void>;
}

export interface EmbedOptions {
  /** Told when the editor opens (true) and when it goes (false), whoever ends it (Escape in the editor ends it itself). */
  onEditingChange?(editing: boolean): void;
  /** Whether an edit may start now (a locked card, a read-only figure: no). Asked by `edit` and the embed's own requests. */
  canEdit?(): boolean;
}

/** The members of Obsidian's Markdown embed that are used here. */
interface MarkdownEmbed {
  editable: boolean;
  useIframe: boolean;
  requestEdit: (() => void) | null;
  editMode: { register(cb: () => void): void } | null | undefined;
  savePromise?: Promise<unknown> | null;
  requestSave: { run(): unknown };
  load(): void;
  unload(): void;
  loadFile(): Promise<void>;
  showEditor(at?: { x: number; y: number }): void;
  showPreview(save?: boolean): void;
}

/** A block of the reading view: its element, and where its Markdown is in the embed's `text`. */
interface PreviewSection {
  el?: unknown;
  start?: { offset?: unknown };
  end?: { offset?: unknown };
}

/** The members of the open editor (`editMode`) and of Obsidian's `Editor` that place the caret. */
interface CaretEditor {
  editor?: { offsetToPos?(offset: number): unknown; setCursor?(pos: unknown): void };
  cm?: { coordsAtPos?(pos: number): { top: number; bottom: number } | null; scrollDOM?: HTMLElement };
  iframeEl?: HTMLIFrameElement | null;
}

/**
 * Where in `source` (Markdown) the end of `rendered` (the text its rendering shows up to a point) is: each rendered
 * character is matched with the next equal one in the source, stepping over what the rendering does not show (`**`,
 * `[[target|`, `## `, a list's `- [ ] `). Whitespace matches whitespace (a soft line break renders as a space), and a
 * rendered character the source does not have is skipped.
 */
export function sourceOffset(rendered: string, source: string): number {
  let at = 0;
  const space = /\s/;
  for (const ch of rendered) {
    const blank = space.test(ch);
    let j = at;
    while (j < source.length && (blank ? !space.test(source[j]) : source[j] !== ch)) j++;
    if (j >= source.length) continue;
    at = j + 1;
  }
  return at;
}

/** The text node and offset under the client point (`at`) in `doc`, if the browser can say. */
function caretAt(doc: Document, at: { x: number; y: number }): { node: Node; offset: number } | null {
  const d = doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null; caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  if (typeof d.caretRangeFromPoint === "function") {
    const range = d.caretRangeFromPoint(at.x, at.y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  if (typeof d.caretPositionFromPoint === "function") {
    const pos = d.caretPositionFromPoint(at.x, at.y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  return null;
}

/**
 * The offset in `embed.text` (what its editor holds) of the character shown at the client point `at` in its rendered
 * view; null when that cannot be told (no section of the rendering there, or the reading view's internals not as
 * expected).
 */
function textOffsetAt(embed: MarkdownEmbed, at: { x: number; y: number }): number | null {
  const preview = (embed as { previewEl?: unknown }).previewEl;
  const sections = (embed as { previewMode?: { renderer?: { sections?: unknown } } }).previewMode?.renderer?.sections;
  const text = (embed as { text?: unknown }).text;
  if (!(preview instanceof Node) || !Array.isArray(sections) || typeof text !== "string") return null;
  const hit = caretAt(preview.ownerDocument ?? document, at);
  if (!hit || !preview.contains(hit.node)) return null;
  for (const section of sections as PreviewSection[]) {
    const el = section.el;
    const start = section.start?.offset;
    const end = section.end?.offset;
    if (!(el instanceof Node) || !el.contains(hit.node) || typeof start !== "number" || typeof end !== "number") continue;
    const range = el.ownerDocument!.createRange();
    range.setStart(el, 0);
    range.setEnd(hit.node, hit.offset);
    return start + Math.min(sourceOffset(range.toString(), text.slice(start, end)), end - start);
  }
  return null;
}

/** How long (ms) the clicked line is held at the click's height while the editor settles (it resizes, and restores its scroll). */
const HOLD_LINE_MS = 400;

/**
 * Puts the open editor's caret at `offset` of its text, once the editor is up (Obsidian places its own caret a tick
 * after `showEditor`, in the editor's window), and scrolls it so that line is at `at.y` (client px), the height at
 * which the rendered text was clicked, as far as the editor scrolls. The editor restores its own scroll as it settles
 * (on its first resizes), so the line is held there, frame by frame, for `HOLD_LINE_MS`, or until the user scrolls,
 * types or presses in it.
 */
function placeCaret(embed: MarkdownEmbed, offset: number, at: { x: number; y: number }): void {
  const open = embed.editMode as (MarkdownEmbed["editMode"] & CaretEditor) | null | undefined;
  const editor = open?.editor;
  if (typeof editor?.offsetToPos !== "function" || typeof editor.setCursor !== "function") return;
  const win = (open?.iframeEl?.ownerDocument?.defaultView ?? globalThis) as Pick<Window, "setTimeout" | "requestAnimationFrame">;
  /** Scrolls the caret's line to the click's height; false when it cannot be measured. */
  const hold = (): boolean => {
    const cm = open?.cm;
    const frame = open?.iframeEl;
    const coords = cm?.coordsAtPos?.(offset);
    const scroller = cm?.scrollDOM;
    if (!coords || !scroller || !frame) return false;
    // The iframe is drawn at the stage's zoom: its px are `scale` screen px.
    const box = frame.getBoundingClientRect();
    const scale = frame.clientWidth > 0 ? box.width / frame.clientWidth : 1;
    const lineY = box.y + ((coords.top + coords.bottom) / 2) * scale;
    const by = (lineY - at.y) / scale;
    if (Math.abs(by) >= 1) scroller.scrollTop += by;
    return true;
  };
  win.setTimeout(() => {
    if (embed.editMode !== open) return;
    try {
      editor.setCursor!(editor.offsetToPos!(offset));
      if (!hold()) return;
    } catch {
      // The caret stays where Obsidian put it.
      return;
    }
    const target = open?.cm?.scrollDOM;
    let stopped = false;
    const stop = (): void => {
      stopped = true;
    };
    const events = ["wheel", "keydown", "pointerdown"] as const;
    for (const type of events) target?.addEventListener(type, stop, { capture: true, once: true });
    const until = Date.now() + HOLD_LINE_MS;
    const frame = (): void => {
      if (stopped || embed.editMode !== open || Date.now() > until) {
        for (const type of events) target?.removeEventListener(type, stop, { capture: true });
        return;
      }
      try {
        hold();
      } catch {
        stopped = true;
      }
      win.requestAnimationFrame(frame);
    };
    win.requestAnimationFrame(frame);
  }, 0);
}

type EmbedCreator = (ctx: { app: App; linktext: string; sourcePath: string; containerEl: HTMLElement; depth: number }, file: TFile, subpath: string) => unknown;

const EMBED_METHODS = ["load", "unload", "loadFile", "showEditor", "showPreview"] as const;

/** Apps already warned about: one warning each, however many cards fall back. */
const warned = new WeakSet<object>();

function warnOnce(app: App, reason: string, error?: unknown): void {
  if (warned.has(app)) return;
  warned.add(app);
  const message = `Link Figures: notes on cards cannot be edited here (${reason}); they are shown read-only.`;
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What is missing from `embed` of what is used here, or null when nothing is. */
function missingMember(embed: unknown): string | null {
  if (typeof embed !== "object" || embed === null) return "it made nothing";
  const e = embed as Record<string, unknown>;
  for (const name of EMBED_METHODS) if (typeof e[name] !== "function") return `it has no ${name}()`;
  const save = e.requestSave as ((() => void) & { run?: unknown }) | undefined;
  if (typeof save !== "function" || typeof save.run !== "function") return "it has no requestSave.run()";
  return null;
}

/** The vault's note at `path` (the object Obsidian keeps for it, which a rename keeps), or null. */
export function noteFile(app: App, path: string): TFile | null {
  const vault = (app as Partial<App>).vault as Partial<App["vault"]> | undefined;
  return typeof vault?.getFileByPath === "function" ? vault.getFileByPath(path) : null;
}

/**
 * Obsidian's editable embed of `file`'s `subpath` (`""`: the whole note) in a new element inside `containerEl`, linked
 * from `sourcePath`; null, with one console warning per app, when the registry, the creator or a member of the embed is
 * missing, or creating it throws. The caller unloads it (`unload`) when it is done with it.
 */
export function openEmbed(app: App, file: TFile, subpath: string, containerEl: HTMLElement, sourcePath: string, options: EmbedOptions = {}): LiveEmbed | null {
  const registry = (app as unknown as { embedRegistry?: { getEmbedCreator?: unknown } }).embedRegistry;
  if (typeof registry?.getEmbedCreator !== "function") {
    warnOnce(app, "Obsidian's embed is not available");
    return null;
  }
  let creator: unknown;
  try {
    creator = (registry.getEmbedCreator as (file: TFile) => unknown).call(registry, file);
  } catch (error) {
    warnOnce(app, `Obsidian's note embed failed: ${errorText(error)}`, error);
    return null;
  }
  if (typeof creator !== "function") {
    // A file that is not a note has no editable embed to give, and that is not Obsidian failing.
    if (file.extension === "md") warnOnce(app, "Obsidian has no embed for notes");
    return null;
  }
  const el = containerEl.appendChild(containerEl.ownerDocument.createElement("div"));
  let embed: MarkdownEmbed;
  try {
    const made = (creator as EmbedCreator)({ app, linktext: file.path + subpath, sourcePath, containerEl: el, depth: 0 }, file, subpath);
    const missing = missingMember(made);
    if (missing !== null) {
      el.remove();
      warnOnce(app, `Obsidian's note embed has changed: ${missing}`);
      return null;
    }
    embed = made as MarkdownEmbed;
  } catch (error) {
    el.remove();
    warnOnce(app, `Obsidian's note embed failed: ${errorText(error)}`, error);
    return null;
  }

  const canEdit = (): boolean => options.canEdit?.() ?? true;
  let unloaded = false;
  const live: LiveEmbed = {
    edit(at) {
      if (unloaded || embed.editMode || !canEdit()) return;
      // The clicked character's place in the note, read from the rendering before it is hidden (see the top of the file).
      let offset: number | null = null;
      try {
        offset = at ? textOffsetAt(embed, at) : null;
      } catch {
        offset = null;
      }
      // Else the point, a copy: the embed converts it into the iframe's in place.
      embed.showEditor(at && offset === null ? { x: at.x, y: at.y } : undefined);
      if (at && offset !== null) placeCaret(embed, offset, at);
      // Read afresh: `showEditor` made it (or did not, for an embed that is not editable).
      const editor = embed.editMode as MarkdownEmbed["editMode"];
      if (!editor) return;
      if (typeof (editor as Partial<NonNullable<MarkdownEmbed["editMode"]>>).register !== "function") {
        // The card could not tell when the edit ends: the editor is closed again, with a save, and not used.
        warnOnce(app, "Obsidian's note editor has changed: it has no editMode.register()");
        embed.showPreview(true);
        return;
      }
      editor.register(() => options.onEditingChange?.(false));
      options.onEditingChange?.(true);
    },
    stopEditing() {
      if (embed.editMode) embed.showPreview(true);
    },
    editing: () => !!embed.editMode,
    async flush() {
      const saving = embed.requestSave.run();
      let wrote = saving !== undefined && saving !== null;
      await saving;
      while (embed.savePromise) {
        wrote = true;
        await embed.savePromise.catch(() => {});
      }
      return wrote;
    },
    unload() {
      if (unloaded) return;
      // Obsidian's unload drops the editor without saving it: the edit is ended (and saved) first. A save that throws
      // does not keep the embed loaded.
      try {
        live.stopEditing();
      } finally {
        unloaded = true;
        embed.unload();
      }
    },
    ready: Promise.resolve(),
  };
  // As Canvas sets them; the embed's own request to edit (its "edit" affordances) goes through the same gate.
  embed.editable = true;
  embed.useIframe = true;
  embed.requestEdit = () => live.edit();
  try {
    embed.load();
    live.ready = embed.loadFile().catch((error: unknown) => console.error(`Link Figures: could not read ${file.path} into its card`, error));
  } catch (error) {
    try {
      embed.unload();
    } catch {
      // Half loaded: whatever it made goes with its element.
    }
    el.remove();
    warnOnce(app, `Obsidian's note embed failed: ${errorText(error)}`, error);
    return null;
  }
  return live;
}
