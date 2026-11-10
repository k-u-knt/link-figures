import { Keymap } from "obsidian";
import type { Plane } from "../links/decoders/tiff-convert";
import { DecodeLimitError } from "../links/decoders/budget";
import { isVectorFile } from "../links/intake-classify";
import { linkedFiles } from "../links/linked-files";
import { resolveFileNode, samplesKey } from "../links/resolver";
import type { Resolved } from "../links/types";
import { fileNodeDefaults } from "../model/defaults";
import type { Document, FileNode, Node, NodeId, PageId } from "../model/types";
import type { Registries } from "../registry";
import { viewNodeType } from "../nodes/placeholder-node";
import { nodeTypeFor, type ImageState, type LinkedPath, type LinkRename, type NodeRenderer, type RenderContext } from "../registry/node-type";
import type { LinkFiguresView } from "./figure-view";
import type { PageLayer } from "./page-layer";

/** What a node's linked files were last tracked from, and what they were (see `NodeHost.trackLinked`). */
interface LinkedState {
  inputs: unknown[];
  key: string;
  links: LinkedPath[];
  paths: string[];
  unresolved: boolean;
}

/**
 * What `NodeType.linkedPaths` reads a node's links from: its content fields (`text`, `file`, `subpath`, compared by
 * value) and what the stage resolved for it (compared by identity: a new resolution is a new object).
 */
function linkedInputs(node: Node, resolved: Resolved | undefined): unknown[] {
  const fields = node as unknown as Record<string, unknown>;
  return [fields.text, fields.file, fields.subpath, resolved];
}

/** A renderer that shows an image can say how big that image is by itself. */
interface MeasuringRenderer extends NodeRenderer {
  naturalSize(): Promise<{ width: number; height: number }>;
  /** The image's size if it has loaded with one, else null. */
  naturalSizeNow(): { width: number; height: number } | null;
  /** The URL the image was loaded from, if it has loaded; else null. */
  imageSourceNow?(): string | null;
  /** Whether it shows an image now (see `ImageState`). */
  imageStateNow?(): ImageState;
}

function isMeasuring(renderer: NodeRenderer): renderer is MeasuringRenderer {
  return typeof (renderer as Partial<MeasuringRenderer>).naturalSize === "function";
}

interface Entry {
  renderer: NodeRenderer;
  /** The element the node type's `mount` added to the page's node host. */
  el: HTMLElement;
  page: PageId;
}

/** Everything about a file node that decides what its link resolves to; a change to any of it needs a new resolution. */
function linkKey(node: FileNode): string {
  return JSON.stringify([node.file, node.subpath, node.show, node.imageIndex, node.pageIndex, node.range, node.adjustments]);
}

/** Which file (and which image in it) a file node shows; not what it draws it with (page, range, adjustments). */
function fileIdentity(node: FileNode): string {
  return JSON.stringify([node.file, node.subpath, node.show, node.imageIndex]);
}

/**
 * What `node`'s link is resolved as: for a node whose type names a link it shows (`NodeType.linkTarget`: a file panel,
 * itself; a note card, its note) a panel of that link, with the node's id; null for a node that has none.
 */
export function resolvableAs(registries: Registries, node: Node, doc: Document, unreadable?: ReadonlySet<NodeId>): FileNode | null {
  let target;
  try {
    target = nodeTypeFor(registries, node, unreadable)?.linkTarget?.(node);
  } catch (error) {
    console.error(`Link Figures: could not tell what node ${node.id} links to`, error);
    return null;
  }
  const page = doc.pages.find((p) => p.id === node.page);
  if (!target || !page) return null;
  return { ...fileNodeDefaults(page, target, []), type: "file", page: page.id, id: node.id };
}

/**
 * Keeps the nodes drawn on the pages in step with the document, and resolves file nodes' links into what they show.
 * The document is the view's `store`; resolutions are kept in the view's `resolvedCache` and `index`.
 */
export class NodeHost {
  private readonly entries = new Map<NodeId, Entry>();
  /** The `linkKey` each file node was last sent to the resolver with, to tell an edit that needs a new resolution. */
  private readonly resolvedKeys = new Map<NodeId, string>();
  /** The newest resolution started for each node. A result that is no longer the newest, or whose node is gone, is dropped. */
  private readonly tokens = new Map<NodeId, number>();
  private nextToken = 0;
  /** The resolutions under way (each never rejects), for `drawn` to wait for. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Samples keys with a `samplesNow` decode under way, so one is started per key at a time. */
  private readonly samplesPending = new Set<string>();
  /** Samples keys whose `samplesNow` decode failed: not tried again (a changed file has a new key). */
  private readonly samplesFailed = new Set<string>();
  /**
   * Samples keys `samplesNow` has decoded since the document last changed: a redraw that their landing caused does not
   * decode them again. Cleared on every change to the document (`renderAll`, `applyChange`, `reset`), so a panel relinked
   * away and back, whose plane was evicted meanwhile, is decoded again when its resolution lands.
   */
  private readonly samplesDecoded = new Set<string>();
  /** Whether the view is drawing its chrome because samples or a resolution landed (`notifySamplesLanded`). */
  private inLandedRedraw = false;
  /** The `fileIdentity` each node's resolution in `resolvedCache` was made for. */
  private readonly resolvedIdentity = new Map<NodeId, string>();
  /**
   * Nodes `samplesNow` said null for because their resolution was for another file, or because they had none yet (a
   * first resolution under way): told when theirs lands.
   */
  private readonly awaitingResolution = new Set<NodeId>();
  /**
   * The samples key `samplesNow` was last asked about for each node: what asked (the inspector) shows that file as it
   * was then. A resolution that lands with another key (the file changed on disk) tells the view once the new samples
   * can be had. Kept with the node's `fileIdentity` then: a relink is not a change of the file.
   */
  private readonly askedKeys = new Map<NodeId, { key: string; identity: string }>();
  /**
   * For each node whose type lists the links its drawing reads (`NodeType.linkedPaths`), what they were read from, what
   * they were and the files they found when last tracked (on the index's `"linked"` channel); see `trackLinked`.
   */
  private readonly linked = new Map<NodeId, LinkedState>();
  /** Nodes with a link among those that finds no file: a file that appears may be it (see `unresolvedLinkers`). */
  private readonly unresolvedLinks = new Set<NodeId>();
  /** Adjustment types already warned about as not registered: one warning per type per view. */
  private readonly warnedUnknown = new Set<string>();
  private readonly ctx: RenderContext;

  constructor(
    private readonly view: LinkFiguresView,
    private readonly pageLayer: PageLayer,
    private readonly registries: Registries,
  ) {
    this.ctx = {
      app: view.app,
      registries,
      // A getter: the figure file can be renamed while it is open.
      get figurePath() {
        return view.file?.path ?? "";
      },
      doc: () => view.store.doc,
      resolved: (id) => view.resolvedCache.get(id),
      openLink: (linktext, evt, newLeaf) => view.openLink(linktext, newLeaf ?? Keymap.isModEvent(evt)),
      component: view,
      // A getter: the view's set is its store's, and a new document comes with a new store.
      get unreadable() {
        return view.unreadableNodes;
      },
    };
  }

  /**
   * Draws every node afresh: unmounts what is drawn, clears the pages' node hosts, mounts `doc`'s nodes. What was
   * resolved is kept for each file node whose link is still the one it was resolved for (a resolution still under way
   * included), so a node drawn again shows its image at once; the rest is forgotten. Resolving what is left is `resolveStale`.
   */
  renderAll(doc: Document): void {
    this.samplesDecoded.clear();
    for (const [id, entry] of this.entries) this.unmountEntry(id, entry);
    this.entries.clear();
    const present = new Set(doc.nodes.map((n) => n.id));
    for (const id of [...this.linked.keys()]) if (!present.has(id)) this.forgetLinked(id);
    // The same page ids survive an external reload, so what the old nodes left in their hosts is cleared explicitly.
    for (const page of doc.pages) this.hostFor(page.id)?.replaceChildren();

    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    for (const id of this.knownIds()) {
      const node = byId.get(id);
      const asFile = node && this.asFile(node, doc);
      if (!asFile || this.resolvedKeys.get(id) !== linkKey(asFile)) this.forgetResolution(id);
    }
    for (const node of doc.nodes) this.mountNode(node);
  }

  /** Forgets every resolution: for a document that has nothing to do with the one before it. Draws nothing. */
  reset(): void {
    this.samplesDecoded.clear();
    for (const id of this.knownIds()) this.forgetResolution(id);
    for (const id of [...this.linked.keys()]) this.forgetLinked(id);
  }

  /**
   * The watcher says files that `ids` depend on changed: each node that resolves a link (`linkTarget`) is resolved
   * again, which draws it; any other is drawn again from scratch (`NodeRenderer.refresh`). Both track their linked
   * files afresh, as what an embedded note embeds may have changed. A node whose renderer follows its file by itself
   * (`NodeRenderer.followsFile`: a note card's live embed) is left alone, so an edit in it is never drawn over; it is
   * resolved again once it no longer does (its note deleted).
   */
  async invalidate(ids: NodeId[]): Promise<void> {
    const doc = this.view.store.doc;
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    const toResolve: NodeId[] = [];
    for (const id of new Set(ids)) {
      const node = byId.get(id);
      if (!node) continue;
      const entry = this.entries.get(id);
      // A drawing that follows its file itself (a note's live embed) is not drawn over: an edit in it may be under way.
      if (this.follows(id, entry)) continue;
      this.linked.delete(id);
      if (this.asFile(node, doc)) {
        toResolve.push(id);
        continue;
      }
      try {
        entry?.renderer.refresh?.();
      } catch (error) {
        console.error(`Link Figures: could not redraw node ${id}`, error);
      }
      this.trackLinked(node);
    }
    await this.resolve(toResolve);
  }

  /**
   * The nodes with a link their drawing reads that found no file (see `NodeType.linkedPaths`) and now finds one: a file
   * that appeared mended them. Asked when a file appears; a node whose links find what they found before is left alone,
   * so a file made anywhere in the vault does not redraw every card with a dangling link.
   */
  unresolvedLinkers(): NodeId[] {
    return [...this.unresolvedLinks].filter((id) => {
      const state = this.linked.get(id);
      if (!state) return true;
      const now = linkedFiles(state.links, this.view.plugin.access);
      return now.unresolved !== state.unresolved || now.paths.join("\n") !== state.paths.join("\n");
    });
  }

  /** Resolves the file nodes of the view's document whose link has not been resolved yet, or has changed since. */
  resolveStale(): Promise<void> {
    const doc = this.view.store.doc;
    const stale = doc.nodes.filter((n) => {
      const asFile = this.asFile(n, doc);
      return !!asFile && this.resolvedKeys.get(n.id) !== linkKey(asFile);
    });
    return this.resolve(stale.map((n) => n.id));
  }

  /**
   * Brings the drawn nodes in line with `doc` after `changed` nodes were added, removed or edited, and draws again each
   * node that is drawn from one of them (see `NodeType.dependsOn`), and with `pagesChanged` (a page added, removed,
   * reordered or resized) each node tied to pages (see `NodeType.tiedPages`, an association), which is drawn from
   * where its pages are. Pages are already rendered.
   */
  applyChange(doc: Document, changed: Set<NodeId>, pagesChanged = false): void {
    this.samplesDecoded.clear();
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    const stale: NodeId[] = [];
    for (const id of changed) {
      const node = byId.get(id);
      if (!node) {
        this.remove(id);
        continue;
      }
      const entry = this.entries.get(id);
      if (!entry) {
        this.mountNode(node);
      } else if (entry.page !== node.page) {
        // Moved to another page: its element has to move to that page's host, so it is drawn again from what is resolved.
        this.unmountEntry(id, entry);
        this.entries.delete(id);
        this.mountNode(node);
      } else {
        this.updateEntry(entry, node);
      }
      const asFile = this.asFile(node, doc);
      if (asFile) {
        if (this.resolvedKeys.get(id) !== linkKey(asFile)) stale.push(id);
      } else if (this.resolvedKeys.has(id)) {
        // Its link is gone (a note card made a text card): what was resolved for it is not its any more.
        this.forgetResolution(id);
      }
    }
    for (const node of doc.nodes) {
      if (changed.has(node.id)) continue;
      const type = nodeTypeFor(this.registries, node, this.view.unreadableNodes);
      const deps = type?.dependsOn?.(node);
      const tied = pagesChanged && (type?.tiedPages?.(node).length ?? 0) > 0;
      const entry = tied || deps?.some((dep) => changed.has(dep)) ? this.entries.get(node.id) : undefined;
      if (entry) this.updateEntry(entry, node);
    }
    if (stale.length > 0) void this.resolve(stale);
  }

  /** A file a link leads to was renamed: each renderer that holds text the model does not yet (an open editor) follows it. */
  renameLinks(rename: LinkRename): void {
    for (const { renderer } of this.entries.values()) renderer.renameLinks?.(rename);
  }

  /** Whether node `id`'s renderer keeps its drawing in step with its file by itself (`NodeRenderer.followsFile`). */
  private follows(id: NodeId, entry: Entry | undefined): boolean {
    try {
      return entry?.renderer.followsFile?.() === true;
    } catch (error) {
      console.error(`Link Figures: could not tell whether node ${id} follows its file`, error);
      return false;
    }
  }

  /**
   * A click on node `id` while it was selected alone, pressed on `target` at `at` (client px): true when its renderer
   * started an edit in place (see `NodeRenderer.edit`).
   */
  edit(id: NodeId, target: EventTarget | null, at: { x: number; y: number }): boolean {
    const renderer = this.entries.get(id)?.renderer;
    try {
      return renderer?.edit?.(target, at) === true;
    } catch (error) {
      console.error(`Link Figures: could not edit node ${id}`, error);
      return false;
    }
  }

  /** Whether `target` is inside an editor in place that is open (`NodeRenderer.isEditing`): its events are the editor's. */
  isEditingAt(target: EventTarget | null): boolean {
    if (!target) return false;
    for (const { renderer } of this.entries.values()) {
      try {
        if (renderer.isEditing?.(target)) return true;
      } catch {
        // A renderer that cannot say is not editing.
      }
    }
    return false;
  }

  /**
   * Ends every edit in place under way, with a save (`NodeRenderer.stopEditing`): before the pages' sheets move or go,
   * which reloads the iframes in them (see `PageLayer`).
   */
  endEdits(): void {
    for (const [id, { renderer }] of this.entries) {
      try {
        if (renderer.isEditing?.()) renderer.stopEditing?.();
      } catch (error) {
        console.error(`Link Figures: could not end the edit of node ${id}`, error);
      }
    }
  }

  /** Writes what every editor in place holds and has not saved yet (`NodeRenderer.flush`). Never rejects. */
  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.entries].map(async ([id, { renderer }]) => {
        try {
          await renderer.flush?.();
        } catch (error) {
          console.error(`Link Figures: could not save what node ${id} is editing`, error);
        }
      }),
    );
  }

  /** Unmounts every node (the view is closing): each renderer lets go of what it holds, an editor saving first. */
  unmountAll(): void {
    for (const [id, entry] of this.entries) this.unmountEntry(id, entry);
    this.entries.clear();
  }

  /** The `.lf-node` element of a node (or whatever its node type mounted), for hit-testing and for rasterising it. */
  elementFor(id: NodeId): HTMLElement | undefined {
    return this.entries.get(id)?.el;
  }

  /**
   * The natural size of the image a node shows. Waits for the image if it is still being resolved or loaded; rejects
   * for a node that shows note content, is missing, or is not drawn.
   */
  naturalSize(id: NodeId): Promise<{ width: number; height: number }> {
    const renderer = this.entries.get(id)?.renderer;
    if (!renderer || !isMeasuring(renderer)) return Promise.reject(new Error(`Link Figures: node ${id} shows no image`));
    return renderer.naturalSize();
  }

  /** The natural size of the image a node shows if it has loaded with one; null otherwise (not loaded, no image, not drawn). */
  naturalSizeNow(id: NodeId): { width: number; height: number } | null {
    const renderer = this.entries.get(id)?.renderer;
    return renderer && isMeasuring(renderer) ? renderer.naturalSizeNow() : null;
  }

  /**
   * Whether node `id` shows an image now (see `ImageState`): `none` for a panel that shows only its badge; null for a
   * node that is not drawn, or whose renderer shows no image of any kind.
   */
  imageStateNow(id: NodeId): ImageState | null {
    const renderer = this.entries.get(id)?.renderer;
    return renderer && isMeasuring(renderer) ? renderer.imageStateNow?.() ?? null : null;
  }

  /** The URL the image a node shows was loaded from, if it has loaded; null otherwise. */
  imageSourceNow(id: NodeId): string | null {
    const renderer = this.entries.get(id)?.renderer;
    return renderer && isMeasuring(renderer) ? renderer.imageSourceNow?.() ?? null : null;
  }

  /**
   * The decoded samples of the TIFF page or raster image panel `id` shows, as the file is now, if they are cached; null
   * otherwise (and for any other node). When they are not cached yet, one decode into the cache starts (none if one for
   * the same file is under way) and the view is told when it lands (`samplesLanded`), so what asked can ask again. A
   * raster panel without adjustments stays drawn by the browser; this only fills the cache.
   */
  samplesNow(id: NodeId): Plane | null {
    const node = this.view.store.doc.nodes.find((n) => n.id === id);
    const resolved = this.view.resolvedCache.get(id);
    if (node?.type !== "file") return null;
    // Not resolved yet (its first resolution is under way): told when it lands, unless it is a vector panel, which has no samples.
    if (!resolved) {
      if (!isVectorFile(node.file)) this.awaitingResolution.add(id);
      return null;
    }
    // A resolution kept on screen while the node's new link resolves is for another file: its samples are not this node's.
    if (this.resolvedIdentity.get(id) !== fileIdentity(node)) {
      this.awaitingResolution.add(id);
      return null;
    }
    if (resolved.kind !== "image") return null;
    const { file, source } = resolved;
    if (source !== "tiff" && source !== "raster") return null;
    const { access, decoders } = this.view.plugin;
    const key = samplesKey(file, source, node.pageIndex, access);
    if (key === undefined) return null;
    this.askedKeys.set(id, { key, identity: fileIdentity(node) });
    const plane = decoders.samples(key);
    if (plane) return plane;
    if (this.samplesPending.has(key) || this.samplesFailed.has(key)) return null;
    // More panels than the cache holds would otherwise evict each other and redraw for ever.
    if (this.inLandedRedraw && this.samplesDecoded.has(key)) return null;
    this.samplesPending.add(key);
    this.samplesDecoded.add(key);
    void (async () => {
      let landed = false;
      try {
        await decoders.decodeSamples(await access.readBinary(file), source, node.pageIndex, key);
        landed = true;
      } catch (error) {
        this.samplesFailed.add(key);
        if (error instanceof DecodeLimitError) console.warn(`Link Figures: ${file.path} is too large to adjust (${error.message})`);
        else console.error(`Link Figures: could not decode the samples of ${file.path}`, error);
      }
      this.samplesPending.delete(key);
      if (landed) this.notifySamplesLanded();
    })();
    return null;
  }

  /** Tells the view that samples it may have asked for can now be had: it draws its chrome again. */
  private notifySamplesLanded(): void {
    if (this.inLandedRedraw) return;
    this.inLandedRedraw = true;
    try {
      this.view.samplesLanded();
    } finally {
      this.inLandedRedraw = false;
    }
  }

  /**
   * Resolves the file nodes among `ids` against the vault, records what each depends on, and redraws them.
   * Never rejects: a resolution that fails shows as a missing link.
   */
  async resolve(ids: NodeId[]): Promise<void> {
    const figure = this.view.file;
    if (!figure || ids.length === 0) return;
    const byId = new Map(this.view.store.doc.nodes.map((n) => [n.id, n] as const));
    const pending: Promise<void>[] = [];
    for (const id of ids) {
      const node = byId.get(id);
      const asFile = node && this.asFile(node, this.view.store.doc);
      if (!asFile) continue;
      const resolution = this.resolveFile(asFile, figure.path);
      this.inFlight.add(resolution);
      void resolution.then(() => this.inFlight.delete(resolution));
      pending.push(resolution);
    }
    await Promise.all(pending);
  }

  /**
   * Resolves once every resolution under way has landed (or failed) and every node has finished drawing what it shows
   * then (see `NodeRenderer.drawn`): what the stage looks like settled, for an export that snapshots it (content cards).
   * A resolution started meanwhile is waited for too. Never rejects.
   */
  async drawn(): Promise<void> {
    for (;;) {
      await Promise.all([...this.inFlight]);
      await Promise.all(
        [...this.entries.values()].map(async ({ renderer }) => {
          try {
            await renderer.drawn?.();
          } catch {
            // A drawing that failed is as drawn as it will get.
          }
        }),
      );
      if (this.inFlight.size === 0) return;
    }
  }

  private async resolveFile(node: FileNode, figurePath: string): Promise<void> {
    const token = ++this.nextToken;
    this.tokens.set(node.id, token);
    this.resolvedKeys.set(node.id, linkKey(node));
    this.warnUnknownAdjustments(node);

    let resolved: Resolved;
    try {
      resolved = await resolveFileNode(node, figurePath, this.view.plugin.access, this.view.plugin.decoders);
    } catch (error) {
      console.error(`Link Figures: could not resolve the link of node ${node.id}`, error);
      resolved = { kind: "missing", reason: "file", deps: [] };
    }

    // Edited again, reloaded or removed while resolving: a newer resolution, or none, owns the node now.
    if (this.tokens.get(node.id) !== token) return;
    const current = this.view.store.doc.nodes.find((n) => n.id === node.id);
    if (!current) return;

    this.view.resolvedCache.set(node.id, resolved);
    this.resolvedIdentity.set(node.id, fileIdentity(node));
    this.view.index.track(node.id, resolved.deps);
    const entry = this.entries.get(node.id);
    if (entry) this.updateEntry(entry, current);
    if (this.awaitingResolution.delete(node.id)) this.notifySamplesLanded();
    else this.followFileChange(current, resolved);
  }

  /**
   * After a resolution of node `node` landed: when what asked for its samples was shown another version of its file
   * (a change on disk, so a new samples key), the view is told once the new samples can be had: at once when the
   * resolution left them in the cache (a TIFF, an adjusted raster), else when the decode `samplesNow` starts lands.
   */
  private followFileChange(node: Node, resolved: Resolved): void {
    const asked = this.askedKeys.get(node.id);
    if (asked === undefined || node.type !== "file" || resolved.kind !== "image" || asked.identity !== fileIdentity(node)) return;
    const { access } = this.view.plugin;
    const key = samplesKey(resolved.file, resolved.source, node.pageIndex, access);
    if (key === undefined || key === asked.key) return;
    // Starts the decode if the plane is not cached (which tells the view when it lands), and asks with the new key.
    const plane = this.samplesNow(node.id);
    if (plane || this.samplesFailed.has(key)) this.notifySamplesLanded();
  }

  /** Warns once per view about each enabled adjustment type that is not registered; the drawing skips it. */
  private warnUnknownAdjustments(node: FileNode): void {
    const registry = this.view.plugin.registries.adjustments;
    for (const { type, enabled } of node.adjustments) {
      if (!enabled || registry.get(type) || this.warnedUnknown.has(type)) continue;
      this.warnedUnknown.add(type);
      console.warn(`Link Figures: no adjustment "${type}" is registered, so it is skipped when drawing (it stays in the file)`);
    }
  }

  /** What `node`'s link is resolved as (see `resolvableAs`), or null when it has none. */
  private asFile(node: Node, doc: Document): FileNode | null {
    return resolvableAs(this.registries, node, doc, this.view.unreadableNodes);
  }

  private mountNode(node: Node): void {
    // A node of a type no plugin registers (another plugin's item, that plugin missing) is drawn as a placeholder.
    const type = viewNodeType(this.registries, node, this.view.unreadableNodes);
    const host = this.hostFor(node.page);
    if (!host) {
      console.warn(`Link Figures: node ${node.id} is on page "${node.page}", which does not exist, so it is not drawn`);
      return;
    }
    try {
      const last = host.lastElementChild;
      const renderer = type.mount(node, host, this.ctx);
      const el = host.lastElementChild;
      if (!el || el === last) throw new Error("mount added no element");
      (el as HTMLElement).dataset.nodeId = node.id;
      this.entries.set(node.id, { renderer, el: el as HTMLElement, page: node.page });
    } catch (error) {
      console.error(`Link Figures: could not draw node ${node.id}`, error);
    }
    this.trackLinked(node);
  }

  private updateEntry(entry: Entry, node: Node): void {
    try {
      entry.renderer.update(node);
    } catch (error) {
      console.error(`Link Figures: could not redraw node ${node.id}`, error);
    }
    this.trackLinked(node);
  }

  /**
   * Tracks the files `node`'s drawing reads (see `NodeType.linkedPaths` and `linkedFiles`) on the index's `"linked"`
   * channel, so the watcher finds the node when one of them changes. Nothing is done while what the links are read from
   * (`linkedInputs`: the node's content fields and its resolution) is unchanged, as on every frame of a drag; nor, the
   * links listed again, while they are what they were.
   */
  private trackLinked(node: Node): void {
    const type = nodeTypeFor(this.registries, node, this.view.unreadableNodes);
    if (!type?.linkedPaths) return;
    const inputs = linkedInputs(node, this.view.resolvedCache.get(node.id));
    const state = this.linked.get(node.id);
    if (state && state.inputs.length === inputs.length && state.inputs.every((v, i) => v === inputs[i])) return;
    let links: LinkedPath[];
    try {
      links = type.linkedPaths(node, { figurePath: this.ctx.figurePath, resolved: (id) => this.view.resolvedCache.get(id) });
    } catch (error) {
      console.error(`Link Figures: could not tell what node ${node.id} links to`, error);
      links = [];
    }
    const key = JSON.stringify(links);
    if (state && state.key === key) {
      state.inputs = inputs;
      return;
    }
    const { paths, unresolved } = linkedFiles(links, this.view.plugin.access);
    this.linked.set(node.id, { inputs, key, links, paths, unresolved });
    this.view.index.track(node.id, paths, "linked");
    if (unresolved) this.unresolvedLinks.add(node.id);
    else this.unresolvedLinks.delete(node.id);
  }

  private forgetLinked(id: NodeId): void {
    this.linked.delete(id);
    this.unresolvedLinks.delete(id);
    this.view.index.track(id, [], "linked");
  }

  private unmountEntry(id: NodeId, entry: Entry): void {
    try {
      entry.renderer.unmount();
    } catch (error) {
      console.error(`Link Figures: could not remove node ${id}`, error);
    }
  }

  /** A node that is gone from the document: undrawn, and no longer resolved or watched. */
  private remove(id: NodeId): void {
    const entry = this.entries.get(id);
    if (entry) this.unmountEntry(id, entry);
    this.entries.delete(id);
    this.forgetResolution(id);
    this.forgetLinked(id);
  }

  /** Every node that has a resolution, or one under way. */
  private knownIds(): Set<NodeId> {
    return new Set([...this.resolvedKeys.keys(), ...this.tokens.keys(), ...this.view.resolvedCache.keys()]);
  }

  private forgetResolution(id: NodeId): void {
    this.resolvedKeys.delete(id);
    this.tokens.delete(id);
    this.view.resolvedCache.delete(id);
    this.resolvedIdentity.delete(id);
    this.awaitingResolution.delete(id);
    this.askedKeys.delete(id);
    // What its link resolved to; what its drawing reads besides (the "linked" channel) is the node's while it is drawn.
    this.view.index.track(id, []);
  }

  /** The page's node host, or undefined for a page that is not rendered (a node pointing at it is skipped, not fatal). */
  private hostFor(page: PageId): HTMLElement | undefined {
    try {
      return this.pageLayer.nodesHost(page);
    } catch {
      return undefined;
    }
  }
}
