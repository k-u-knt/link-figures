import type { App, EventRef } from "obsidian";
import { MAX_DPI, MIN_DPI } from "../constants";
import type { Decoders, Resolved, VaultAccess } from "../links/types";
import type { Document, NodeId, Page, PageId } from "../model/types";
import type { Registries } from "../registry";
import { CommandError } from "../registry/command";
import type { Exporter } from "../registry/exporter";
import type { LinkFiguresSettings } from "../settings/settings";
import type { AssetMap } from "./asset-types";
import { collectAssets } from "./assets";
import { cardTextSource, writeCardFiles } from "./cards-markdown";
import { exportOptions, splitCommonOptions } from "./export-options";
import { buildPageSvg } from "./svg-builder";
import { isTrimFallback, trimAssets, type TrimDeps } from "./trim";
import { exportDir, exportFolderFor, exportPathFor, safeFileName, uniqueFileNames, writeExportFile } from "./write";

export { exportOptions, optionDefaults } from "./export-options";

export interface ExportRun {
  exporter: Exporter;
  doc: Document;
  pages: Page[];
  /** The figure's file name without `.lnkfig.md`. */
  baseName: string;
  /** Vault folder the files are written to; `""` is the vault root. */
  folder: string;
  dpi: number;
  /** Pages larger than this (mm, either side) are still exported, with a warning. */
  maxPageSizeMm: number;
  /** The exporter's options (see `exportOptions`); none when left out. */
  options?: Record<string, unknown>;
  /** The nodes their plugin could not read when the figure was loaded: skipped, with a warning (`BuildOptions.unreadable`). */
  unreadable?: ReadonlySet<NodeId>;
  /** "Export cards as Markdown" (`options.cards: "markdown"`): each exported page's cards, with their images, beside the files. */
  cards?: boolean;
  /** The figure's vault path, which a text card's links are resolved from; `""` when left out. */
  figurePath?: string;
}

export interface ExportDeps {
  app: App;
  registries: Registries;
  resolved: (id: NodeId) => Resolved | undefined;
  elementFor: (id: NodeId) => HTMLElement | undefined;
  /** The stage's decoders, so panels are drawn in the export as they are on the stage. */
  decoders: Decoders;
  /** How each panel's source is trimmed to the part of it that shows (see `trimAssets`). */
  trim: TrimDeps;
  /**
   * True for a vault path no export may write over: the figure file and its sources (see `isFigureSource`). With
   * `cardsFile`, the path is a cards Markdown file, which may replace a note (an earlier export of it).
   */
  isProtected: (path: string, cardsFile?: boolean) => boolean;
  /** The vault, as links are resolved in it: the note cards' sections are read through it (with the figure closed too). */
  access?: VaultAccess;
}

/**
 * Collects each page's assets, trims each panel's source to the part of it that shows, builds the page's SVG, lets the
 * exporter turn them into files and writes those to the vault. The warnings returned are everything that could not be
 * done faithfully (assets that failed, nodes skipped, nodes rasterised, and files not written because their path is
 * protected: `deps.isProtected`), and what trimming did to each cropped panel. They come in that order of urgency: the
 * panels that could not be trimmed first, then the other warnings, then the rest of the trim report, so that the
 * notice, which shows only the first few, never leaves out a panel embedded whole for a line saying all went well.
 * `files` counts the files actually written, and `paths` are their vault paths. The exporter is given the cards'
 * Markdown (`ExportInput.cardMarkdown`, read from the vault when first asked for), and with `run.cards` each exported
 * page's cards are written as Markdown after its files (`writeCardFiles`), with what could not be read reported last.
 */
export async function runExport(run: ExportRun, deps: ExportDeps): Promise<{ files: number; paths: string[]; warnings: string[] }> {
  const { app } = deps;
  const warnings: string[] = [];
  const trimReport: string[] = [];
  const svgs = new Map<PageId, string>();
  const assets = new Map<PageId, AssetMap>();

  const fileAt = (path: string) => {
    const file = app.vault.getFileByPath(path);
    if (!file) throw new Error(`File not found in vault: ${path}`);
    return file;
  };

  for (const page of run.pages) {
    if (page.width > run.maxPageSizeMm || page.height > run.maxPageSizeMm) {
      warnings.push(`Page "${page.name}" is ${page.width} × ${page.height} mm, over the ${run.maxPageSizeMm} mm page limit`);
    }
    const collected = await collectAssets(run.doc, page, {
      app,
      resolved: deps.resolved,
      elementFor: deps.elementFor,
      readBinary: (path) => app.vault.readBinary(fileAt(path)),
      readText: (path) => app.vault.cachedRead(fileAt(path)),
      decoders: deps.decoders,
      dpi: run.dpi,
      warnings,
    });
    const pageAssets = await trimAssets(run.doc, page, collected, deps.trim, trimReport, run.exporter.pdfPanels);
    const built = buildPageSvg(run.doc, page, deps.registries, pageAssets, { unreadable: run.unreadable });
    warnings.push(...built.warnings);
    assets.set(page.id, pageAssets);
    svgs.set(page.id, built.svg);
  }

  // The cards' Markdown, read from the vault once, when the exporter (presenter notes) or the cards pass first asks.
  const cardWarnings: string[] = [];
  const cardTexts = cardTextSource({ doc: run.doc, registries: deps.registries, figurePath: run.figurePath ?? "", access: deps.access, unreadable: run.unreadable }, cardWarnings);
  const result = await run.exporter.run(
    {
      doc: run.doc,
      pages: run.pages,
      svgs,
      assets,
      registries: deps.registries,
      warnings,
      baseName: run.baseName,
      dpi: run.dpi,
      unreadable: run.unreadable,
      cardMarkdown: async (page) => (await cardTexts(page)).map((card) => card.markdown),
    },
    run.options ?? {},
  );

  // Two files of one run with the same name (two pages called "Page 2", or "A/B" and "A:B") would be one file on disk,
  // the second written over the first: they are told apart here, whichever exporter made them.
  const names = uniqueFileNames(result.files.map((file) => file.name));
  const reported = [...result.warnings];
  result.files.forEach((file, i) => {
    if (names[i] !== safeFileName(file.name)) reported.push(`Page name '${file.name}' is used more than once; wrote '${names[i]}'`);
  });
  const paths: string[] = [];
  for (const [i, file] of result.files.entries()) {
    // An export named like one of the figure's sources ("Figure 2.pdf" beside a plot of that name) must not replace it;
    // writing over an earlier export is routine and stays silent.
    const path = exportPathFor(run.folder, names[i]);
    if (deps.isProtected(path)) {
      reported.push(`Refused to overwrite ${path}: it is a source of this figure`);
      continue;
    }
    await writeExportFile(app, run.folder, names[i], file.blob);
    paths.push(path);
  }
  if (run.cards) {
    const written = await writeCardFiles(
      { pages: run.pages, baseName: run.baseName, folder: run.folder, figurePath: run.figurePath ?? "", texts: cardTexts },
      { app, access: deps.access, isProtected: deps.isProtected },
      cardWarnings,
    );
    paths.push(...written);
  }
  reported.push(...cardWarnings);
  return {
    files: paths.length,
    paths,
    // A line said for several pages, or by the exporter again, is listed once, whichever exporter ran.
    warnings: [...new Set([...trimReport.filter(isTrimFallback), ...reported, ...trimReport.filter((line) => !isTrimFallback(line))])],
  };
}

/** The success message: how many files were written, and to which folder. */
export function exportSummary(files: number, folder: string): string {
  return `Exported ${files} file(s) to ${exportDir(folder) || "the vault root"}`;
}

/** The dpi preset buttons of the export modal: the resolutions journals ask for. */
export const DPI_PRESETS = [300, 600, 1000] as const;

/** What to export, as the modal and `api.export` ask for it. */
export interface ExportRequest {
  /** An exporter's id: `svg`, `pdf`, `png`, `tiff`, `pptx`, or one another plugin registered. */
  format: string;
  /** The page in focus (`current`, the default), every page, or these pages in this order. */
  pages?: "current" | "all" | PageId[];
  /** The resolution, from `MIN_DPI` to `MAX_DPI`; the settings' export dpi when left out. */
  dpi?: number;
  /** The exporter's options (`Exporter.options()`), by key; each left out has its default. */
  options?: Record<string, unknown>;
}

export interface ExportOutcome {
  /** The vault paths of the files written. */
  files: string[];
  warnings: string[];
}

/** A figure to export, open in a view: what the view has of it, and what the export needs from the plugin. */
export interface FigureExportTarget {
  figurePath: string;
  /** The figure's name, which starts each file's. */
  baseName: string;
  doc: Document;
  /** The page in focus: what `pages: "current"` exports. */
  currentPage: Page | undefined;
  settings: Pick<LinkFiguresSettings, "exportFolder" | "exportDpi" | "maxPageSizeMm">;
  deps: ExportDeps;
  /**
   * Resolves once its links are resolved and its nodes drawn (`NodeHost.drawn`), so content cards can be snapshotted;
   * waited on for at most `DRAWN_WAIT_MS` before the export. None: the figure is taken as drawn.
   */
  drawn?: () => Promise<void>;
  /** The nodes their plugin could not read when the figure was loaded (the load result's `unreadable`), which are skipped. */
  unreadable?: ReadonlySet<NodeId>;
}

/** How long an export waits for its figure to be drawn (`FigureExportTarget.drawn`) before it goes on with a warning. */
export const DRAWN_WAIT_MS = 30_000;

/** Whether `drawn()` settled (resolved or rejected: a drawing that failed is as drawn as it will get) within `ms`. */
async function drawnWithin(drawn: () => Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([drawn().then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `asked` is a `pages` request in form: `"current"`, `"all"` or a list of page ids (left out is `"current"`). */
function pagesInForm(asked: unknown): asked is ExportRequest["pages"] {
  return asked === undefined || asked === "current" || asked === "all" || (Array.isArray(asked) && asked.every((id) => typeof id === "string"));
}

function pagesOf(doc: Document, current: Page | undefined, asked: ExportRequest["pages"] = "current"): Page[] {
  if (!pagesInForm(asked)) throw new CommandError('api.export: pages must be "current", "all" or a list of page ids');
  let pages: Page[];
  if (asked === "current") pages = current ? [current] : [];
  else if (asked === "all") pages = doc.pages;
  else {
    pages = [...new Set(asked)].map((id) => {
      const page = doc.pages.find((p) => p.id === id);
      if (!page) throw new CommandError(`api.export: there is no page "${id}"`);
      return page;
    });
  }
  if (pages.length === 0) throw new CommandError("api.export: no pages to export");
  return pages;
}

/**
 * Checks what of `request` needs no figure: the format, the resolution (the settings' when left out), the exporter's
 * options and the form of `pages`. Returns the exporter, the dpi and the options to run it with; an Error otherwise.
 */
function checkRequest(registries: Registries, exportDpi: number, request: ExportRequest): { exporter: Exporter; dpi: number; options: Record<string, unknown>; cards: boolean } {
  const exporter = registries.exporters.get(request.format);
  if (!exporter) {
    throw new CommandError(`api.export: there is no format "${request.format}" (${registries.exporters.all().map((e) => e.id).join(", ")})`);
  }
  const dpi = request.dpi ?? exportDpi;
  if (typeof dpi !== "number" || !Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    throw new CommandError(`api.export: the resolution must be a number from ${MIN_DPI} to ${MAX_DPI} dpi`);
  }
  if (!pagesInForm(request.pages)) throw new CommandError('api.export: pages must be "current", "all" or a list of page ids');
  // The options every format has are the run's; the rest are the exporter's own.
  const { common, rest } = splitCommonOptions(request.options);
  let options: Record<string, unknown>;
  try {
    options = exportOptions(exporter, rest);
  } catch (error) {
    throw new CommandError(`api.export: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { exporter, dpi: Math.round(dpi), options, cards: common.cards };
}

/**
 * Exports the figure as `request` asks, to the export folder (the settings', else the figure's own), as the modal does:
 * the request is checked whole before anything is drawn, and no file may replace a source of the figure (`deps.isProtected`).
 */
export async function exportFigure(target: FigureExportTarget, request: ExportRequest): Promise<ExportOutcome & { folder: string }> {
  const { exporter, dpi, options, cards } = checkRequest(target.deps.registries, target.settings.exportDpi, request);
  const pages = pagesOf(target.doc, target.currentPage, request.pages);
  const folder = exportFolderFor(target.settings, target.figurePath);
  // Content cards are snapshotted from the stage: wait (bounded) for it to settle, open figures too.
  const drawn = target.drawn ? await drawnWithin(target.drawn, DRAWN_WAIT_MS) : true;
  const { paths, warnings } = await runExport(
    {
      exporter,
      doc: target.doc,
      pages,
      baseName: target.baseName,
      folder,
      dpi,
      maxPageSizeMm: target.settings.maxPageSizeMm,
      options,
      unreadable: target.unreadable,
      cards,
      figurePath: target.figurePath,
    },
    target.deps,
  );
  if (!drawn) warnings.unshift(`"${target.baseName}": exported before every item was drawn`);
  return { files: paths, warnings, folder };
}

/** A figure opened in a background tab for an export: see `exportInBackground`. */
export interface BackgroundFigure {
  target: FigureExportTarget;
  /** Resolves once its links are resolved and its nodes drawn (see `NodeHost.drawn`), so content cards can be snapshotted. */
  drawn(): Promise<void>;
  /**
   * Closes the tab; resolves once it is closed, with whatever it saves on closing written, so a call queued on the
   * figure after the export cannot read the file before that write lands, or be overwritten by it.
   */
  close(): void | Promise<void>;
}

/** A background tab as `closeBackgroundTab` closes it. */
export interface BackgroundTab {
  /** Writes what the view would save (nothing, for a figure it only read). */
  save(): Promise<void>;
  detach(): void;
  /** Whether it is the active tab: the user has switched to it meanwhile. */
  isActive(): boolean;
  /** Lets go of what the tab was watched with (see `takeBackgroundLeaf`), whether it was closed or not. */
  release?(): void;
}

/** What `takeBackgroundLeaf` uses of Obsidian's workspace (`activeLeaf` and the rest, as 1.15 has them). */
export interface TabWorkspace<L> {
  activeLeaf: L | null;
  getLeaf(kind: "tab"): L;
  iterateAllLeaves(fn: (leaf: L) => void): void;
  setActiveLeaf(leaf: L, params: { focus: boolean }): void;
  on(name: "active-leaf-change", fn: (leaf: L | null) => void): EventRef;
  offref(ref: EventRef): void;
}

/** A leaf `takeBackgroundLeaf` gave out, as `closeBackgroundTab` closes it (with the view's `save` added). */
export interface BackgroundLeaf<L> extends Omit<BackgroundTab, "save"> {
  leaf: L;
}

/**
 * A tab for exporting a figure in the background. `getLeaf("tab")` makes a new tab and, with "Always focus new tabs"
 * on (Obsidian's default), makes it the active one, so it read as a tab the user had switched to and was left open
 * after the export: the tab that was active is made active again at once. The tab counts as the user's
 * (`isActive`) only once they switch to it themselves and while it stays active. Obsidian hands out the most recent tab
 * instead of a new one when that is an empty tab ("New tab"): that tab is the user's, and is given back empty rather
 * than closed.
 */
export function takeBackgroundLeaf<L extends { detach(): void; setViewState(state: { type: string }): Promise<void> }>(workspace: TabWorkspace<L>): BackgroundLeaf<L> {
  const previous = workspace.activeLeaf;
  const existing = new Set<L>();
  workspace.iterateAllLeaves((l) => existing.add(l));
  const leaf = workspace.getLeaf("tab");
  const reused = existing.has(leaf);
  if (!reused && previous && previous !== leaf && workspace.activeLeaf === leaf) workspace.setActiveLeaf(previous, { focus: false });
  let switchedTo = false;
  const ref = workspace.on("active-leaf-change", (active) => {
    switchedTo = active === leaf;
  });
  return {
    leaf,
    isActive: () => switchedTo && workspace.activeLeaf === leaf,
    detach: () => {
      if (reused) void leaf.setViewState({ type: "empty" });
      else leaf.detach();
    },
    release: () => workspace.offref(ref),
  };
}

/**
 * Closes a tab `exportInBackground` opened: it saves first, and is waited on, so a call queued after the export cannot
 * race that write. A save that fails is logged and does not fail the export. A tab the user has switched to meanwhile
 * is theirs now, and is left open.
 */
export async function closeBackgroundTab(tab: BackgroundTab): Promise<void> {
  try {
    await tab.save();
  } catch (error) {
    console.error("Link Figures: could not save the figure exported in the background", error);
  }
  if (!tab.isActive()) tab.detach();
  tab.release?.();
}

/** What `exportInBackground` needs of the plugin, so that it can be tested without Obsidian. */
export interface BackgroundExportHost {
  registries: Registries;
  settings: Pick<LinkFiguresSettings, "exportDpi">;
  /** The figure's document as its file has it; rejects when there is no such file or it is no figure. */
  read(path: string): Promise<Document>;
  /** Opens the figure in a background tab; rejects (with the tab closed) when it cannot be opened as a figure. */
  open(path: string): Promise<BackgroundFigure>;
}

/**
 * Exports the figure at `path`, which no view has open, as `exportFigure` does: the request is checked first, against
 * the figure's file for its pages, so that a refusal opens no tab; then the figure is opened in a background tab, which
 * is waited on until it is drawn (a content card is snapshotted from the stage; at most `DRAWN_WAIT_MS`) and closed
 * again whatever happens.
 */
export async function exportInBackground(host: BackgroundExportHost, path: string, request: ExportRequest): Promise<ExportOutcome> {
  checkRequest(host.registries, host.settings.exportDpi, request);
  const doc = await host.read(path);
  pagesOf(doc, doc.pages[0], request.pages);
  const figure = await host.open(path);
  try {
    // The bounded wait for it to be drawn is exportFigure's.
    const { files, warnings } = await exportFigure({ ...figure.target, drawn: () => figure.drawn() }, request);
    return { files, warnings };
  } finally {
    await figure.close();
  }
}
