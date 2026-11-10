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
      // A copy: the embed converts the point into the iframe's in place.
      embed.showEditor(at ? { x: at.x, y: at.y } : undefined);
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
