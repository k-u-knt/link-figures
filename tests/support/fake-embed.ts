/**
 * A stand-in for Obsidian's internal embed registry (`app.embedRegistry`) and the Markdown embed it creates, with the
 * members the embed adapter uses, shaped as Obsidian 1.15 has them: `getEmbedCreator(file)` gives a creator that is
 * called `(ctx, file, subpath)`; the embed has `editable`, `useIframe`, `requestEdit`, `load`, `unload`, `loadFile`,
 * `showEditor`, `showPreview`, `editMode` (with `register`), `text`, `dirty`, `savePromise` and a debounced
 * `requestSave` with `run` and `cancel`. Typing (`type`) marks the embed dirty and queues a save, as Obsidian's editor
 * does; `showPreview(true)`, and `requestSave.run()` while a save is queued, write the text (`writes`).
 */
export interface EmbedFile {
  path: string;
  extension: string;
}

export class FakeEmbed {
  editable = false;
  useIframe = false;
  requestEdit: (() => void) | null = null;
  editMode: { editorEl: HTMLElement; register(cb: () => void): void } | null = null;
  text = "";
  dirty = false;
  savePromise: Promise<void> | null = null;
  loaded = false;
  unloaded = false;
  readonly containerEl: HTMLElement;
  readonly previewEl: HTMLElement;
  readonly editorEl: HTMLElement;
  /** What was written to the note, in order. */
  readonly writes: string[] = [];
  /** Every `showEditor` call's argument. */
  readonly editorCalls: unknown[] = [];
  readonly calls: string[] = [];
  private pending = false;
  /** What the note was last read or written as: a save of the same text writes nothing, as Obsidian's. */
  private lastSaved = "";
  private ends: (() => void)[] = [];
  readonly requestSave: (() => void) & { run(): Promise<void> | undefined; cancel(): void };

  constructor(
    readonly ctx: { app: unknown; linktext: string; sourcePath: string; containerEl: HTMLElement; depth: number },
    readonly file: EmbedFile,
    readonly subpath: string,
  ) {
    this.containerEl = ctx.containerEl;
    this.containerEl.classList.add("markdown-embed");
    this.previewEl = this.containerEl.ownerDocument.createElement("div");
    this.previewEl.className = "markdown-embed-content";
    this.editorEl = this.containerEl.ownerDocument.createElement("div");
    this.editorEl.className = "markdown-embed-content";
    this.containerEl.append(this.previewEl, this.editorEl);
    const request = () => {
      this.pending = true;
    };
    this.requestSave = Object.assign(request, {
      run: () => {
        if (!this.pending) return undefined;
        this.pending = false;
        return this.write();
      },
      cancel: () => {
        this.pending = false;
      },
    });
  }

  load(): void {
    this.calls.push("load");
    this.loaded = true;
  }

  unload(): void {
    this.calls.push("unload");
    this.unloaded = true;
    // As Obsidian's: the editor goes without a save.
    this.destroyEditor(false);
  }

  async loadFile(): Promise<void> {
    this.calls.push("loadFile");
    this.text = this.lastSaved = `text of ${this.file.path}${this.subpath}`;
    this.previewEl.textContent = this.text;
  }

  showEditor(at?: unknown): void {
    this.calls.push("showEditor");
    this.editorCalls.push(at);
    if (!this.editable) return;
    if (!this.editMode) {
      const editorEl = this.editorEl.ownerDocument.createElement("div");
      editorEl.className = "fake-editor";
      this.editorEl.appendChild(editorEl);
      this.editMode = { editorEl, register: (cb) => void this.ends.push(cb) };
    }
  }

  showPreview(save = false): void {
    this.calls.push(`showPreview(${save})`);
    this.destroyEditor(save);
  }

  /** As typing in the editor: the text changes, and a save is queued (debounced). */
  type(text: string): void {
    this.text = text;
    this.dirty = true;
    this.requestSave();
  }

  private destroyEditor(save: boolean): void {
    if (!this.editMode) return;
    if (save) {
      this.requestSave.cancel();
      void this.write();
    }
    this.editMode.editorEl.remove();
    this.editMode = null;
    const ends = this.ends;
    this.ends = [];
    for (const end of ends) end();
  }

  private write(): Promise<void> {
    this.dirty = false;
    if (this.text === this.lastSaved) return Promise.resolve();
    this.lastSaved = this.text;
    this.writes.push(this.text);
    return Promise.resolve();
  }
}

/** A fake `app.embedRegistry`: creates `FakeEmbed`s for `.md` files, and records them. */
export function fakeEmbedRegistry() {
  const embeds: FakeEmbed[] = [];
  const registry = {
    getEmbedCreator: (file: EmbedFile) =>
      file.extension === "md"
        ? (ctx: FakeEmbed["ctx"], f: EmbedFile, subpath: string) => {
            const embed = new FakeEmbed(ctx, f, subpath);
            embeds.push(embed);
            return embed;
          }
        : null,
  };
  return { registry, embeds };
}
