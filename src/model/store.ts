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
   * (`file`, `subpath`) of file nodes: history refers to nodes by their place in the document, which has not changed, so
   * it stays valid. A node that undo or redo brings back comes with the link it had when it was removed.
   */
  replace(doc: Document, label = "replace", options: { keepHistory?: boolean } = {}): void {
    const before = this.current;
    this.current = doc;
    if (!options.keepHistory) {
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
