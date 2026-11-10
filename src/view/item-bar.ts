import { setIcon } from "obsidian";
import { EDITING_CLASS, EDITING_EVENT } from "../constants";
import { nodeWorldRect, type Pt } from "../model/geometry";
import type { Document, Node, NodeId } from "../model/types";
import type { Registries } from "../registry";
import type { Command, CommandContext, ItemBarChoice } from "../registry/command";
import { commandApplies } from "./menu-model";

/** Under this many stage px of room above the item, the bar goes below it. */
const ROOM_ABOVE_PX = 40;
/** The gap between the bar and the item, in stage px (the CSS translate in `.lf-item-bar` uses the same). */
const GAP_PX = 8;

/** What the item bar needs of the figure view. */
export interface ItemBarHost {
  plugin: { registries: Registries };
  store: { doc: Document };
  viewport: { toScreen(p: Pt): Pt };
  readOnly: boolean;
  /** The group whose members are the units selected and acted on (see `LinkFiguresView.enteredGroup`), or null. */
  enteredGroup: NodeId | null;
  unreadableNodes?: ReadonlySet<NodeId>;
  nodeHost: { elementFor(id: NodeId): HTMLElement | undefined };
  selectedIds(): NodeId[];
  commandContext(): CommandContext;
  runCommandById(id: string, args?: Record<string, unknown>): void;
  /** A drag, a resize, a marquee or a tool's drag is under way (see `PointerController.busy`). */
  gestureUnderWay(): boolean;
}

/** One entry of the bar: a button, or a dropdown (`choice`). */
export interface ItemBarEntry {
  id: string;
  name: string;
  icon: string;
  disabled: boolean;
  choice?: ItemBarChoice;
}

/**
 * The bar's entries for item `node`, from the command registry: every command that lists the node's type
 * (`Command.itemBar`) and shows for it now (`itemBarShows`), by `itemBarOrder`, then in the registry's order. One that
 * does not apply is disabled. A command that cannot tell is left out. In a read-only view (`readOnly`) only the commands
 * that change nothing are listed (`Command.readOnlySafe`: Open source).
 */
export function itemBarModel(registries: Pick<Registries, "commands">, ctx: CommandContext, node: Node, readOnly = false): ItemBarEntry[] {
  const listed = registries.commands.all().filter((c) => c.itemBar?.includes(node.type) && (!readOnly || c.readOnlySafe === true));
  const order = (c: Command) => c.itemBarOrder ?? Infinity;
  const entries: ItemBarEntry[] = [];
  for (const command of [...listed].sort((a, b) => order(a) - order(b))) {
    try {
      if (command.itemBarShows && !command.itemBarShows(ctx, node.id)) continue;
      const choice = command.itemBarChoice?.(ctx, node.id);
      entries.push({ id: command.id, name: command.name, icon: command.icon ?? "square", disabled: !commandApplies(command, ctx), ...(choice ? { choice } : {}) });
    } catch (error) {
      console.error(`Link Figures: could not tell how to show "${command.name}" in the item bar`, error);
    }
  }
  return entries;
}

/** The item the bar is for in `view` now, or null: see `ItemBar`. */
function barItem(view: ItemBarHost): Node | null {
  if (view.gestureUnderWay()) return null;
  const ids = view.selectedIds();
  if (ids.length !== 1) return null;
  const node = view.store.doc.nodes.find((n) => n.id === ids[0]);
  if (!node || view.unreadableNodes?.has(node.id)) return null;
  // Only at the level being worked on: a member of a group that has not been entered is not the item.
  if ((node.parent ?? null) !== (view.enteredGroup ?? null)) return null;
  if (view.nodeHost.elementFor(node.id)?.classList.contains(EDITING_CLASS)) return null;
  return node;
}

/** A choice's option value as the DOM holds it: null and a page id never mix up, nor with the `mixed` entry. */
const encode = (value: string | null) => (value === null ? "none" : `v:${value}`);
const MIXED = "mixed";

/**
 * A small bar floating just above the one selected item (a card), in screen space (a child of the stage, not of the
 * zoomed viewport), so it keeps its size when zoomed; it is never exported. Its entries are commands that opt in by
 * node type (`Command.itemBar`), run through the view (`runCommandById`) as a script runs them. It shows only for
 * exactly one item selected at the current group level (in a read-only view with only what changes nothing, see
 * `Command.readOnlySafe`), and hides for a multi-selection, during a drag or a resize (`gestureUnderWay`) and while the item is edited in place (`EDITING_CLASS`). Its entries are
 * rebuilt whenever what they show changes (a page added, renamed or deleted, a tie made), so a dropdown never offers
 * a page that has gone; a choice that lands after its page went is refused by its command.
 */
export class ItemBar {
  readonly el: HTMLElement;
  private view: ItemBarHost | null = null;
  private item: NodeId | null = null;
  /** What the entries were built from, so an unchanged bar keeps its DOM (and an open dropdown stays open). */
  private built = "";

  constructor(parent: HTMLElement) {
    const doc = parent.ownerDocument;
    this.el = doc.createElement("div");
    this.el.className = "lf-item-bar";
    this.el.hidden = true;
    parent.appendChild(this.el);
    // The bar's presses are its own: the stage must not take them as a press on the canvas (which deselects).
        // The wheel goes on to the stage, so zoom and pan work over the bar too.
    for (const type of ["pointerdown", "mousedown", "dblclick", "contextmenu", "keydown"] as const) {
      this.el.addEventListener(type, (ev) => ev.stopPropagation());
    }
  }

  /** Brings the bar in line with `view`: whether it shows, what it holds, and where it is. */
  sync(view: ItemBarHost, rebuild = false): void {
    this.view = view;
    const node = barItem(view);
    const entries = node ? itemBarModel(view.plugin.registries, view.commandContext(), node, view.readOnly) : [];
    if (!node || entries.length === 0) {
      this.item = null;
      this.el.hidden = true;
      return;
    }
    const signature = JSON.stringify([node.id, entries]);
    if (rebuild || signature !== this.built || this.item !== node.id) this.build(node.id, entries, signature);
    this.item = node.id;
    this.el.hidden = false;
    this.place(view, node);
  }

  /** Removes the bar from the stage. */
  destroy(): void {
    this.el.remove();
  }

  private place(view: ItemBarHost, node: Node): void {
    const box = nodeWorldRect(view.store.doc, node);
    const top = view.viewport.toScreen({ x: box.x + box.width / 2, y: box.y });
    const below = top.y < ROOM_ABOVE_PX;
    const at = below ? view.viewport.toScreen({ x: box.x + box.width / 2, y: box.y + box.height }) : top;
    this.el.classList.toggle("is-below", below);
    // Kept inside the stage: its middle at least half its width from either side, and, below the item, its bottom in.
    // A stage not yet laid out (no size) is not clamped to.
    const stage = this.el.parentElement;
    const width = stage?.clientWidth ?? 0;
    const height = stage?.clientHeight ?? 0;
    const half = this.el.offsetWidth / 2;
    let x = at.x;
    let y = at.y;
    if (width > 0) x = Math.min(Math.max(x, half), Math.max(half, width - half));
    if (below && height > 0) y = Math.min(y, height - this.el.offsetHeight - GAP_PX);
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  private build(id: NodeId, entries: ItemBarEntry[], signature: string): void {
    this.built = signature;
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    const doc = this.el.ownerDocument;
    for (const entry of entries) {
      if (entry.choice) {
        this.el.appendChild(this.dropdown(id, entry, entry.choice));
        continue;
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "clickable-icon lf-item-bar-button";
      button.setAttribute("aria-label", entry.name);
      button.disabled = entry.disabled;
      setIcon(button, entry.icon);
      button.addEventListener("click", () => this.run(entry.id, id));
      this.el.appendChild(button);
    }
  }

  private dropdown(id: NodeId, entry: ItemBarEntry, choice: ItemBarChoice): HTMLSelectElement {
    const doc = this.el.ownerDocument;
    const select = doc.createElement("select");
    select.className = "dropdown lf-item-bar-choice";
    select.setAttribute("aria-label", entry.name);
    select.disabled = entry.disabled;
    const option = (value: string, label: string, disabled = false) => {
      const el = doc.createElement("option");
      el.value = value;
      el.textContent = label;
      el.disabled = disabled;
      select.appendChild(el);
    };
    if (choice.value === undefined) option(MIXED, choice.mixed ?? "", true);
    for (const o of choice.options) option(encode(o.value), o.label);
    select.value = choice.value === undefined ? MIXED : encode(choice.value);
    select.addEventListener("change", () => {
      const raw = select.value;
      if (raw === MIXED) return;
      const value = raw === "none" ? null : raw.startsWith("v:") ? raw.slice(2) : raw;
      this.run(entry.id, id, { [choice.param]: value });
    });
    return select;
  }

  /** Runs command `commandId` for item `id` through the view (see `Command.itemBar` for its arguments). */
  private run(commandId: string, id: NodeId, extra?: Record<string, unknown>): void {
    const view = this.view;
    if (!view) return;
    const command = view.plugin.registries.commands.get(commandId);
    if (!command) return;
    // Keys (Delete, Cmd+Z) belong to the stage, and the bar has just taken the focus from it; Edit then takes it on.
    this.el.closest<HTMLElement>(".lf-stage")?.focus({ preventScroll: true });
    if (command.params && Object.hasOwn(command.params, "id")) view.runCommandById(commandId, { id, ...extra });
    else view.runCommandById(commandId);
    // Drawn again from the figure, whatever the command did: a refused choice does not stay shown.
    this.sync(view, true);
  }
}

/** What the bar's wiring needs besides the view: the stage element and the pointer controller's gestures. */
export interface ItemBarWiringParts {
  /** Where a node's `EDITING_EVENT` bubbles to (the stage). */
  stage: HTMLElement;
  gestures: { onGestureChange(fn: () => void): () => void };
}

/** The hooks the figure view calls: `sync` after the chrome is drawn, `viewportApplied` after a pan or a zoom. */
export interface ItemBarWiring {
  sync(): void;
  viewportApplied(): void;
  detach(): void;
}

/**
 * Wires `bar` to `view`, in one place for the figure view and the tests alike: it is brought in line when a card's
 * in-place edit begins or ends (`EDITING_EVENT` on the stage), when a gesture begins or ends (`onGestureChange`), after
 * a pan or a zoom (`viewportApplied`, at once rather than a frame later), and on every `sync` (the view's chrome: the
 * selection and the document). A failure is logged, never thrown into an edit.
 */
export function wireItemBar(view: ItemBarHost, bar: ItemBar, parts: ItemBarWiringParts): ItemBarWiring {
  const sync = () => {
    try {
      bar.sync(view);
    } catch (error) {
      console.error("Link Figures: could not draw the item bar", error);
    }
  };
  parts.stage.addEventListener(EDITING_EVENT, sync);
  const stopGestures = parts.gestures.onGestureChange(sync);
  return {
    sync,
    viewportApplied: sync,
    detach() {
      parts.stage.removeEventListener(EDITING_EVENT, sync);
      stopGestures();
      bar.destroy();
    },
  };
}
