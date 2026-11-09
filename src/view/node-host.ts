import { Keymap } from "obsidian";
import type { Plane } from "../links/decoders/tiff-convert";
import { isVectorFile } from "../links/intake-classify";
import { resolveFileNode, samplesKey } from "../links/resolver";
import type { Resolved } from "../links/types";
import type { Document, FileNode, Node, NodeId, PageId } from "../model/types";
import type { Registries } from "../registry";
import type { ImageState, NodeRenderer, RenderContext } from "../registry/node-type";
import type { LinkFiguresView } from "./figure-view";
import type { PageLayer } from "./page-layer";

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
      openLink: (linktext, evt) => view.openLink(linktext, Keymap.isModEvent(evt)),
      component: view,
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
    // The same page ids survive an external reload, so what the old nodes left in their hosts is cleared explicitly.
    for (const page of doc.pages) this.hostFor(page.id)?.replaceChildren();

    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    for (const id of this.knownIds()) {
      const node = byId.get(id);
      if (node?.type !== "file" || this.resolvedKeys.get(id) !== linkKey(node)) this.forgetResolution(id);
    }
    for (const node of doc.nodes) this.mountNode(node);
  }

  /** Forgets every resolution: for a document that has nothing to do with the one before it. Draws nothing. */
  reset(): void {
    this.samplesDecoded.clear();
    for (const id of this.knownIds()) this.forgetResolution(id);
  }

  /** Resolves the file nodes of the view's document whose link has not been resolved yet, or has changed since. */
  resolveStale(): Promise<void> {
    const stale = this.view.store.doc.nodes.filter((n) => n.type === "file" && this.resolvedKeys.get(n.id) !== linkKey(n));
    return this.resolve(stale.map((n) => n.id));
  }

  /**
   * Brings the drawn nodes in line with `doc` after `changed` nodes were added, removed or edited, and draws again each
   * node that is drawn from one of them (see `NodeType.dependsOn`). Pages are already rendered.
   */
  applyChange(doc: Document, changed: Set<NodeId>): void {
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
      if (node.type === "file" && this.resolvedKeys.get(id) !== linkKey(node)) stale.push(id);
    }
    for (const node of doc.nodes) {
      if (changed.has(node.id)) continue;
      const deps = this.registries.nodeTypes.get(node.type)?.dependsOn?.(node);
      const entry = deps?.some((dep) => changed.has(dep)) ? this.entries.get(node.id) : undefined;
      if (entry) this.updateEntry(entry, node);
    }
    if (stale.length > 0) void this.resolve(stale);
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
        console.error(`Link Figures: could not decode the samples of ${file.path}`, error);
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
      if (node?.type === "file") pending.push(this.resolveFile(node, figure.path));
    }
    await Promise.all(pending);
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

  private mountNode(node: Node): void {
    const type = this.registries.nodeTypes.get(node.type);
    if (!type) {
      console.warn(`Link Figures: no node type "${node.type}" is registered, so node ${node.id} is not drawn`);
      return;
    }
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
  }

  private updateEntry(entry: Entry, node: Node): void {
    try {
      entry.renderer.update(node);
    } catch (error) {
      console.error(`Link Figures: could not redraw node ${node.id}`, error);
    }
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
    this.view.index.untrack(id);
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
