import type { App } from "obsidian";
import { MAX_DPI, MIN_DPI } from "../constants";
import type { Decoders, Resolved } from "../links/types";
import type { Document, NodeId, Page, PageId } from "../model/types";
import type { Registries } from "../registry";
import type { Exporter } from "../registry/exporter";
import type { Field } from "../registry/fields";
import type { LinkFiguresSettings } from "../settings/settings";
import type { AssetMap } from "./asset-types";
import { collectAssets } from "./assets";
import { buildPageSvg } from "./svg-builder";
import { isTrimFallback, trimAssets, type TrimDeps } from "./trim";
import { exportDir, exportFolderFor, exportPathFor, safeFileName, uniqueFileNames, writeExportFile } from "./write";

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
  /** True for a vault path no export may write over: the figure file and its sources (see `isFigureSource`). */
  isProtected: (path: string) => boolean;
}

/**
 * Collects each page's assets, trims each panel's source to the part of it that shows, builds the page's SVG, lets the
 * exporter turn them into files and writes those to the vault. The warnings returned are everything that could not be
 * done faithfully (assets that failed, nodes skipped, nodes rasterised, and files not written because their path is
 * protected: `deps.isProtected`), and what trimming did to each cropped panel. They come in that order of urgency: the
 * panels that could not be trimmed first, then the other warnings, then the rest of the trim report, so that the
 * notice, which shows only the first few, never leaves out a panel embedded whole for a line saying all went well.
 * `files` counts the files actually written, and `paths` are their vault paths.
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

  const result = await run.exporter.run(
    { doc: run.doc, pages: run.pages, svgs, assets, registries: deps.registries, warnings, baseName: run.baseName, dpi: run.dpi, unreadable: run.unreadable },
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

/** The kinds of field an exporter's options may use, and so the ones the modal draws. */
const OPTION_KINDS = new Set<Field["kind"]>(["select", "toggle", "number", "text"]);

const isOption = (field: Field) => OPTION_KINDS.has(field.kind);

/** An option field's value when none is given: a select's first choice, a toggle off, a number's minimum (or 0), empty text. */
function fieldDefault(field: Field): unknown {
  switch (field.kind) {
    case "select":
      return field.options?.[0]?.value ?? "";
    case "toggle":
      return false;
    case "number":
      return field.min ?? 0;
    default:
      return "";
  }
}

/** The value of each of the option fields when none is given (a `Field` has no default of its own). */
export function optionDefaults(fields: Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter(isOption).map((field) => [field.key, fieldDefault(field)]));
}

/** Why `value` is not one `field` takes, or null when it is. */
function badValue(field: Field, value: unknown): string | null {
  switch (field.kind) {
    case "select": {
      const choices = (field.options ?? []).map((o) => o.value);
      return choices.includes(value as string) ? null : `must be one of ${choices.join(", ")}`;
    }
    case "toggle":
      return typeof value === "boolean" ? null : "must be true or false";
    case "number": {
      const [min, max] = [field.min ?? -Infinity, field.max ?? Infinity];
      const ok = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
      return ok ? null : `must be a number from ${min} to ${max}`;
    }
    default:
      return typeof value === "string" ? null : "must be text";
  }
}

/** The options the exporter is run with: its defaults, with `given` over them. An unknown option or a bad value is an Error. */
export function exportOptions(exporter: Exporter, given: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error(`${exporter.id}: options must be an object`);
  const fields = exporter.options().filter(isOption);
  for (const [key, value] of Object.entries(given)) {
    const field = fields.find((f) => f.key === key);
    if (!field) throw new Error(`${exporter.id}: unknown option "${key}"`);
    const problem = badValue(field, value);
    if (problem) throw new Error(`${exporter.id}: option "${key}" ${problem}`);
  }
  return { ...optionDefaults(fields), ...given };
}

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
  if (!pagesInForm(asked)) throw new Error('export: pages must be "current", "all" or a list of page ids');
  let pages: Page[];
  if (asked === "current") pages = current ? [current] : [];
  else if (asked === "all") pages = doc.pages;
  else {
    pages = [...new Set(asked)].map((id) => {
      const page = doc.pages.find((p) => p.id === id);
      if (!page) throw new Error(`export: there is no page "${id}"`);
      return page;
    });
  }
  if (pages.length === 0) throw new Error("export: no pages to export");
  return pages;
}

/**
 * Checks what of `request` needs no figure: the format, the resolution (the settings' when left out), the exporter's
 * options and the form of `pages`. Returns the exporter, the dpi and the options to run it with; an Error otherwise.
 */
function checkRequest(registries: Registries, exportDpi: number, request: ExportRequest): { exporter: Exporter; dpi: number; options: Record<string, unknown> } {
  const exporter = registries.exporters.get(request.format);
  if (!exporter) {
    throw new Error(`export: there is no format "${request.format}" (${registries.exporters.all().map((e) => e.id).join(", ")})`);
  }
  const dpi = request.dpi ?? exportDpi;
  if (typeof dpi !== "number" || !Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    throw new Error(`export: the resolution must be a number from ${MIN_DPI} to ${MAX_DPI} dpi`);
  }
  if (!pagesInForm(request.pages)) throw new Error('export: pages must be "current", "all" or a list of page ids');
  const options = exportOptions(exporter, request.options);
  return { exporter, dpi: Math.round(dpi), options };
}

/**
 * Exports the figure as `request` asks, to the export folder (the settings', else the figure's own), as the modal does:
 * the request is checked whole before anything is drawn, and no file may replace a source of the figure (`deps.isProtected`).
 */
export async function exportFigure(target: FigureExportTarget, request: ExportRequest): Promise<ExportOutcome & { folder: string }> {
  const { exporter, dpi, options } = checkRequest(target.deps.registries, target.settings.exportDpi, request);
  const pages = pagesOf(target.doc, target.currentPage, request.pages);
  const folder = exportFolderFor(target.settings, target.figurePath);
  // Content cards are snapshotted from the stage: wait (bounded) for it to settle, open figures too.
  const drawn = target.drawn ? await drawnWithin(target.drawn, DRAWN_WAIT_MS) : true;
  const { paths, warnings } = await runExport(
    { exporter, doc: target.doc, pages, baseName: target.baseName, folder, dpi, maxPageSizeMm: target.settings.maxPageSizeMm, options, unreadable: target.unreadable },
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
