import { applyPatches, enablePatches, produceWithPatches, type Patch } from "immer";
import { COALESCE_MS } from "../constants";
import type { Document, Node, NodeId } from "./types";

enablePatches();

export interface ChangeEvent {
  kind: "commit" | "undo" | "redo" | "replace";
  label: string;
  /** Exactly the nodes that were added, removed or edited; drives per-node re-rendering. */
  changedNodeIds: Set<NodeId>;
  pagesChanged: boolean;
}

interface HistoryEntry {
  label: string;
  /** Applied to redo. */
  patches: Patch[];
  /** Applied to undo; for a merged entry, newest step first. */
  inversePatches: Patch[];
  time: number;
}

type Listener = (ev: ChangeEvent) => void;

/**
 * The single mutation path for a document: every edit goes through `commit`, every reload through `replace`.
 * History is patch-based, and commits with the same label in quick succession (a drag) merge into one undo step.
 */
export class DocumentStore {
  private current: Document;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** The entry the next commit may merge into. Undo, redo and replace clear it, so navigating history always ends a run. */
  private mergeTarget: HistoryEntry | null = null;
  private listeners = new Set<Listener>();

  constructor(doc: Document, private readonly now: () => number = Date.now) {
    this.current = doc;
  }

  get doc(): Document {
    return this.current;
  }

  /** A recipe that changes nothing leaves no history entry and emits no event. */
  commit(label: string, recipe: (draft: Document) => void): void {
    const before = this.current;
    // The wrapper discards the recipe's return value: immer rejects a producer that both mutates and returns.
    const [after, patches, inversePatches] = produceWithPatches(before, draft => { recipe(draft); });
    if (patches.length === 0) return;
    this.current = after;
    this.redoStack = [];

    const time = this.now();
    const target = this.mergeTarget;
    if (target && target.label === label && time - target.time < COALESCE_MS) {
      target.patches = target.patches.concat(patches);
      target.inversePatches = inversePatches.concat(target.inversePatches);
      target.time = time;
    } else {
      const entry: HistoryEntry = { label, patches, inversePatches, time };
      this.undoStack.push(entry);
      this.mergeTarget = entry;
    }
    this.emit({ kind: "commit", label, ...describeChange(patches, before, after) });
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push(entry);
    this.step("undo", entry, entry.inversePatches);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.undoStack.push(entry);
    this.step("redo", entry, entry.patches);
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Swaps in a document loaded from elsewhere. Not an edit: it leaves no history entry, and by default both history
   * stacks are cleared. `keepHistory` is for a document that differs from the current one only in the link targets
   * (`file`, `subpath`) of file nodes: the nodes keep their places, so what history says of other fields stays valid,
   * and the targets it holds for those nodes are rebased onto the new ones (see `rebaseHistory`), so that undo and redo
   * of a delete, an insertion or a page removal do not bring an old target back.
   */
  replace(doc: Document, label = "replace", options: { keepHistory?: boolean } = {}): void {
    const before = this.current;
    this.current = doc;
    if (options.keepHistory) {
      const links = changedLinks(before.nodes, doc.nodes);
      if (links.size > 0) {
        for (const entry of this.undoStack) rebaseHistory(entry, links);
        for (const entry of this.redoStack) rebaseHistory(entry, links);
      }
    } else {
      this.undoStack = [];
      this.redoStack = [];
      this.mergeTarget = null;
    }
    this.emit({
      kind: "replace",
      label,
      changedNodeIds: differingNodeIds(before.nodes, doc.nodes),
      pagesChanged: !deepEqual(before.pages, doc.pages),
    });
  }

  subscribe(fn: (ev: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private step(kind: "undo" | "redo", entry: HistoryEntry, patches: Patch[]): void {
    const before = this.current;
    const after = applyPatches(before, patches);
    this.current = after;
    this.mergeTarget = null;
    this.emit({ kind, label: entry.label, ...describeChange(patches, before, after) });
  }

  private emit(ev: ChangeEvent): void {
    // Iterate a copy so a listener may unsubscribe (itself or another) mid-dispatch.
    for (const fn of [...this.listeners]) fn(ev);
  }
}

function describeChange(
  patches: readonly Patch[],
  before: Document,
  after: Document,
): Pick<ChangeEvent, "changedNodeIds" | "pagesChanged"> {
  return {
    changedNodeIds: changedNodeIds(patches, before, after),
    pagesChanged: patches.some(p => p.path[0] === "pages"),
  };
}

/**
 * Patch paths nominate candidate nodes; each candidate is then confirmed against the two documents, so the
 * result is exact. A patch at `["nodes", i, ...]` nominates the nodes at index i in both documents (a removal
 * or an insertion shifts later siblings, so the after-document alone would miss a removed node); a patch on
 * the array as a whole nominates every node. A candidate counts if it is in only one document, or differs.
 */
function changedNodeIds(patches: readonly Patch[], before: Document, after: Document): Set<NodeId> {
  const candidates = new Set<NodeId>();
  for (const { path } of patches) {
    if (path[0] !== "nodes") continue;
    if (path.length === 1) {
      for (const n of before.nodes) candidates.add(n.id);
      for (const n of after.nodes) candidates.add(n.id);
    } else {
      const i = Number(path[1]);
      const b = before.nodes[i];
      const a = after.nodes[i];
      if (b) candidates.add(b.id);
      if (a) candidates.add(a.id);
    }
  }
  const changed = new Set<NodeId>();
  if (candidates.size === 0) return changed;
  const beforeById = indexById(before.nodes);
  const afterById = indexById(after.nodes);
  for (const id of candidates) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    if (!a || !b || !deepEqual(a, b)) changed.add(id);
  }
  return changed;
}

type Link = { file: string; subpath: string };

/** The new link of each file node that is in both lists with a different one. */
function changedLinks(before: readonly Node[], after: readonly Node[]): Map<NodeId, Link> {
  const beforeById = indexById(before);
  const links = new Map<NodeId, Link>();
  for (const node of after) {
    const old = beforeById.get(node.id);
    if (node.type === "file" && old?.type === "file" && (old.file !== node.file || old.subpath !== node.subpath)) {
      links.set(node.id, { file: node.file, subpath: node.subpath });
    }
  }
  return links;
}

/**
 * Brings the link targets that an entry's patches carry up to date. A patch that adds or replaces `["nodes"]` (a delete
 * written as a filter, which holds the whole old list) or `["nodes", i]` (a splice, which holds each node it shifts, and an
 * insertion) has nodes as its value, with the targets they had then; those of the nodes in `links` are set to the new ones.
 * Nodes that are not in `links`, such as one that was deleted and so is in no file for Obsidian to rewrite, keep what they
 * have. Patches deeper in a node (a move) carry no link, and the patches' own structure is left as it is.
 */
function rebaseHistory(entry: HistoryEntry, links: ReadonlyMap<NodeId, Link>): void {
  const rebase = (patches: Patch[]): Patch[] =>
    patches.map(patch => {
      if (patch.path[0] !== "nodes" || patch.path.length > 2 || !("value" in patch)) return patch;
      const value = relinkValue(patch.value, links);
      return value === patch.value ? patch : { ...patch, value };
    });
  entry.patches = rebase(entry.patches);
  entry.inversePatches = rebase(entry.inversePatches);
}

/** `value` (a node, or a list of nodes) with the links of the nodes in `links` replaced; the same object when none is. */
function relinkValue(value: unknown, links: ReadonlyMap<NodeId, Link>): unknown {
  if (Array.isArray(value)) {
    const relinked = value.map(item => relinkValue(item, links));
    return relinked.some((item, i) => item !== value[i]) ? relinked : value;
  }
  const id = typeof value === "object" && value !== null ? (value as { id?: unknown }).id : undefined;
  const link = typeof id === "string" ? links.get(id) : undefined;
  return link ? { ...(value as object), ...link } : value;
}

/** The ids of the nodes that are in only one of the lists, or are in both and differ. */
function differingNodeIds(before: readonly Node[], after: readonly Node[]): Set<NodeId> {
  const beforeById = indexById(before);
  const afterById = indexById(after);
  const differing = new Set<NodeId>();
  for (const [id, b] of beforeById) {
    const a = afterById.get(id);
    if (!a || !deepEqual(a, b)) differing.add(id);
  }
  for (const id of afterById.keys()) if (!beforeById.has(id)) differing.add(id);
  return differing;
}

function indexById(nodes: readonly Node[]): Map<NodeId, Node> {
  return new Map(nodes.map(n => [n.id, n]));
}

/** Structural equality for JSON-like values (documents hold nothing else). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every(k => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}
