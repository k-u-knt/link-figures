import type { Stop } from "../model/types";
import { addStop, moveStop, removeStop, reverseRamp, stopCss } from "../paint/ramp";
import type { UndoStep } from "../registry/command";
import type { Field } from "../registry/fields";
import type { ColorRamp, RampGeometryType, RampPreset } from "../registry/ramp";

/** How far (CSS px) below the slider a handle must be pulled for its release to remove the stop. */
export const DROP_OFF_PX = 24;
/** An arrow key moves the selected stop by this much; with Shift, by `KEY_STEP_LARGE`. */
export const KEY_STEP = 0.01;
export const KEY_STEP_LARGE = 0.1;

type Read = (key: string) => unknown;
type Write = (key: string, value: unknown, step?: UndoStep) => void;

/**
 * What the colour slider needs from the field it is part of. It edits a ramp, never a paint: `write` is told the whole
 * new ramp (the paint field writes the paint it makes, and brings the inspector in line), with `step` as for any field
 * write ("start"/"continue" for a drag's moves, then `endMerge`; "own" for a one-off action such as Reverse).
 */
export interface RampSliderHost {
  /** The paint field's key: the slider's own controls are keyed under it (`fill.stop.color`). */
  key: string;
  label: string;
  read(): ColorRamp | undefined;
  write(ramp: ColorRamp, step?: UndoStep): void;
  endMerge?(): void;
  geometries(): RampGeometryType[];
  presets(): RampPreset[];
  /** The inspector's own field rows, for the selected stop's colour, opacity and offset. */
  renderFields(container: HTMLElement, fields: Field[], read: Read, write: Write): void;
  syncFields(container: HTMLElement, fields: Field[], read: Read): void;
}

/**
 * What outlives one drawing of the slider: the paint field draws it again when its controls change (a solid that gains
 * a stop gets its geometry fields), and the selected stop, and the keyboard focus on it, must carry over.
 */
export interface RampSliderState {
  selected: number;
  /** The selected handle is to have the focus once it is drawn (a key acted on it). */
  refocus: boolean;
}

/** A ramp's stops as a left-to-right CSS gradient, opacity included. */
export function rampCss(stops: readonly Stop[]): string {
  if (stops.length === 0) return "none";
  if (stops.length === 1) return `linear-gradient(${stopCss(stops[0])}, ${stopCss(stops[0])})`;
  return `linear-gradient(to right, ${stops.map((s) => `${stopCss(s)} ${Math.round(s.offset * 10000) / 100}%`).join(", ")})`;
}

/** An offset from a pointer, to a thousandth: a file keeps tidy numbers. */
const pointerOffset = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

/**
 * The colour slider: a bar that draws the ramp (over a checkerboard, so opacity shows), a handle per stop under it, the
 * selected stop's row, and Reverse, the geometry toggle and a presets menu above it. Every action writes a whole new
 * ramp. A click on the bar adds a stop in the ramp's colour there; a handle is dragged to move its stop (one undo
 * step), pulled more than `DROP_OFF_PX` below the slider to remove it, double-clicked for its colour picker. A handle
 * is a focusable `role="slider"`: arrow keys move it (Shift for more), Home and End take it to the ends, Delete and
 * Backspace remove it, Tab goes to the next.
 */
export class RampSlider {
  private readonly root: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly track: HTMLElement;
  private readonly handles: HTMLElement;
  private readonly geometryEl: HTMLElement;
  private readonly stopRow: HTMLElement;
  private readonly presetsButton: HTMLElement;
  private menu: HTMLElement | null = null;
  /** While the menu is open: closes it on a press anywhere outside it (⋯ toggles it itself). */
  private readonly pressOutside = (e: Event): void => {
    const target = e.target as Node | null;
    if (!this.menu || (target && (this.menu.contains(target) || this.presetsButton.contains(target)))) return;
    this.closeMenu();
  };
  private handleEls: HTMLElement[] = [];
  private drawnHandles: string | null = null;
  private drawnGeometry: string | null = null;
  private drawnRow: string | null = null;
  private drag: { index: number; started: boolean; off: boolean } | null = null;

  constructor(
    holder: HTMLElement,
    private readonly host: RampSliderHost,
    private readonly state: RampSliderState,
  ) {
    this.root = holder.createDiv({ cls: "lf-ramp" });
    const head = this.root.createDiv({ cls: "lf-ramp-head" });
    const reverse = head.createEl("button", { cls: "lf-ramp-reverse", text: "⇄", attr: { type: "button", "aria-label": "Reverse the colours", title: "Reverse" } });
    reverse.addEventListener("click", () => this.reverse());
    this.geometryEl = head.createDiv({ cls: "lf-ramp-geometry", attr: { role: "group", "aria-label": "Gradient shape" } });
    this.presetsButton = head.createEl("button", {
      cls: "lf-ramp-presets-button",
      text: "⋯",
      attr: { type: "button", "aria-label": "Colour presets", title: "Presets", "aria-haspopup": "menu", "aria-expanded": "false" },
    });
    this.presetsButton.addEventListener("click", () => (this.menu ? this.closeMenu() : this.openMenu()));

    this.track = this.root.createDiv({ cls: "lf-ramp-track" });
    const bar = this.track.createDiv({ cls: "lf-ramp-bar", attr: { "aria-hidden": "true" } });
    this.fill = bar.createDiv({ cls: "lf-ramp-fill" });
    this.handles = this.track.createDiv({ cls: "lf-ramp-handles" });
    bar.addEventListener("pointerdown", (e: Event) => this.addAt(e as PointerEvent));
    this.track.addEventListener("pointermove", (e: Event) => this.moveDrag(e as PointerEvent));
    this.track.addEventListener("pointerup", (e: Event) => this.endDrag(e as PointerEvent, true));
    for (const type of ["pointercancel", "lostpointercapture"]) this.track.addEventListener(type, (e: Event) => this.endDrag(e as PointerEvent, false));

    this.stopRow = this.root.createDiv({ cls: "lf-ramp-stop" });
    this.sync();
  }

  /** Brings the slider in line with the ramp the field reads now. */
  sync(): void {
    const ramp = this.host.read();
    if (!ramp) return;
    const n = ramp.stops.length;
    this.state.selected = Math.min(Math.max(0, this.state.selected), Math.max(0, n - 1));
    this.fill.setAttribute("style", `background-image: ${rampCss(ramp.stops)}`);

    const handles = JSON.stringify(ramp.stops);
    if (handles !== this.drawnHandles) this.drawHandles(ramp);
    else this.markSelected();

    // The toggle shows only for a gradient: a solid has no shape.
    const geometry = n >= 2 ? `${ramp.geometry.kind}|${this.host.geometries().map((g) => g.kind).join(",")}` : "";
    if (geometry !== this.drawnGeometry) this.drawGeometry(ramp);

    const row = `${this.state.selected}|${n > 1}`;
    if (row !== this.drawnRow) this.drawStopRow(n);
    else this.host.syncFields(this.stopRow, this.stopFields(n), this.readStop);
  }

  private drawHandles(ramp: ColorRamp): void {
    const hadFocus = this.handleHasFocus();
    this.drawnHandles = JSON.stringify(ramp.stops);
    this.handles.empty();
    const n = ramp.stops.length;
    this.handleEls = ramp.stops.map((stop, i) => {
      const percent = Math.round(stop.offset * 10000) / 100;
      const handle = this.handles.createDiv({
        cls: "lf-ramp-handle",
        attr: {
          role: "slider",
          tabindex: "0",
          "aria-label": `${this.host.label}: colour stop ${i + 1} of ${n}`,
          "aria-valuemin": "0",
          "aria-valuemax": "1",
          "aria-valuenow": String(stop.offset),
          "aria-valuetext": `${percent}%, ${stop.color}`,
          "data-index": String(i),
          style: `left: ${percent}%; --lf-stop-color: ${stopCss(stop)}`,
        },
      });
      handle.addEventListener("pointerdown", (e: Event) => this.startDrag(e as PointerEvent, i));
      handle.addEventListener("dblclick", () => this.openPicker());
      handle.addEventListener("focus", () => this.select(i));
      handle.addEventListener("keydown", (e: Event) => this.onKey(e as KeyboardEvent, i));
      return handle;
    });
    this.markSelected();
    if (hadFocus || this.state.refocus) this.focusSelected();
  }

  private markSelected(): void {
    this.handleEls.forEach((h, i) => h.toggleClass("lf-ramp-handle-selected", i === this.state.selected));
  }

  private handleHasFocus(): boolean {
    const active = this.root.ownerDocument?.activeElement;
    return !!active && this.handles.contains(active);
  }

  private focusSelected(): void {
    this.state.refocus = false;
    this.handleEls[this.state.selected]?.focus();
  }

  /** Makes stop `i` the selected one: its handle marked, its row shown. Writes nothing. */
  private select(i: number): void {
    if (this.state.selected === i) return;
    this.state.selected = i;
    this.sync();
  }

  private drawGeometry(ramp: ColorRamp): void {
    const n = ramp.stops.length;
    const kinds = this.host.geometries();
    this.drawnGeometry = n >= 2 ? `${ramp.geometry.kind}|${kinds.map((g) => g.kind).join(",")}` : "";
    this.geometryEl.empty();
    if (n < 2) return;
    for (const kind of kinds) {
      const on = kind.kind === ramp.geometry.kind;
      const button = this.geometryEl.createEl("button", {
        cls: on ? ["lf-ramp-geometry-option", "is-active"] : "lf-ramp-geometry-option",
        text: kind.name,
        attr: { type: "button", "aria-pressed": String(on), "data-kind": kind.kind },
      });
      button.addEventListener("click", () => {
        const now = this.host.read();
        if (!now || now.geometry.kind === kind.kind) return;
        this.host.write({ stops: now.stops, geometry: kind.defaults() }, "own");
      });
    }
  }

  /** The selected stop's fields: its colour, its opacity, and with more than one stop its offset. */
  private stopFields(n: number): Field[] {
    const k = `${this.host.key}.stop`;
    return [
      { kind: "color", key: `${k}.color`, label: "Colour" },
      { kind: "number", key: `${k}.opacity`, label: "Opacity", min: 0, max: 1, step: 0.05 },
      ...(n > 1 ? [{ kind: "number", key: `${k}.offset`, label: "Offset", min: 0, max: 1, step: 0.01 } as Field] : []),
    ];
  }

  private readonly readStop = (key: string): unknown => {
    const stop = this.host.read()?.stops[this.state.selected];
    if (!stop) return undefined;
    const part = key.slice(key.lastIndexOf(".") + 1);
    if (part === "opacity") return typeof stop.opacity === "number" ? stop.opacity : 1;
    return part === "color" ? stop.color : part === "offset" ? stop.offset : undefined;
  };

  private readonly writeStop = (key: string, value: unknown): void => {
    const ramp = this.host.read();
    const i = this.state.selected;
    const stop = ramp?.stops[i];
    if (!ramp || !stop) return;
    const part = key.slice(key.lastIndexOf(".") + 1);
    if (part === "offset" && typeof value === "number") {
      const moved = moveStop(ramp, i, value);
      this.state.selected = moved.index;
      this.host.write(moved.ramp, "own");
      return;
    }
    const changed = { ...stop, [part]: value } as Stop;
    const stops = ramp.stops.map((s, j) => (j === i ? changed : s));
    // A colour picker's run of changes merges into one undo step, as any colour field's does; a typed opacity is its own.
    this.host.write({ ...ramp, stops }, part === "color" ? undefined : "own");
  };

  private drawStopRow(n: number): void {
    this.drawnRow = `${this.state.selected}|${n > 1}`;
    this.stopRow.empty();
    this.host.renderFields(this.stopRow, this.stopFields(n), this.readStop, this.writeStop);
    const buttons = this.stopRow.createDiv({ cls: "lf-ramp-stop-buttons" });
    const add = buttons.createEl("button", { cls: "lf-stop-add", text: "Add stop", attr: { type: "button" } });
    add.addEventListener("click", () => this.addAfterSelected());
    const remove = buttons.createEl("button", { cls: "lf-stop-remove", text: "Remove", attr: { type: "button" } });
    remove.disabled = n <= 1;
    remove.addEventListener("click", () => this.removeSelected(false));
  }

  /** "Add stop": half way between the selected stop and the next (the one before, for the last), in the ramp's colour there. */
  private addAfterSelected(): void {
    const ramp = this.host.read();
    if (!ramp) return;
    const i = this.state.selected;
    const here = ramp.stops[i]?.offset ?? 0;
    const next = ramp.stops[i + 1]?.offset ?? (ramp.stops.length > 1 ? ramp.stops[i - 1]?.offset : undefined) ?? (here < 0.5 ? 1 : 0);
    const added = addStop(ramp, pointerOffset((here + next) / 2));
    this.state.selected = added.index;
    this.host.write(added.ramp, "own");
  }

  private removeSelected(refocus: boolean): void {
    const ramp = this.host.read();
    if (!ramp || ramp.stops.length <= 1) return;
    const i = this.state.selected;
    this.state.selected = Math.min(i, ramp.stops.length - 2);
    this.state.refocus = refocus;
    this.host.write(removeStop(ramp, i), "own");
    if (this.state.refocus) this.focusSelected();
  }

  private reverse(): void {
    const ramp = this.host.read();
    if (!ramp) return;
    this.state.selected = ramp.stops.length - 1 - this.state.selected;
    this.host.write(reverseRamp(ramp), "own");
  }

  private openPicker(): void {
    const input = this.stopRow.querySelector<HTMLInputElement>(`[data-key="${this.host.key}.stop.color"]`);
    input?.click?.();
  }

  private openMenu(): void {
    this.closeMenu();
    const menu = this.root.createDiv({ cls: "lf-ramp-presets", attr: { role: "menu", "aria-label": "Colour presets" } });
    this.menu = menu;
    this.presetsButton.setAttribute("aria-expanded", "true");
    // In the capture phase, so a press that something else handles (the bar) still closes it.
    this.root.ownerDocument?.addEventListener?.("pointerdown", this.pressOutside, true);
    const items = this.host.presets().map((preset) => {
      const item = menu.createEl("button", { cls: "lf-ramp-preset", text: preset.name, attr: { type: "button", role: "menuitem", "data-preset": preset.id } });
      item.addEventListener("click", () => {
        this.closeMenu();
        const ramp = this.host.read();
        if (!ramp) return;
        const next = preset.apply(ramp, this.state.selected);
        this.state.selected = Math.min(this.state.selected, Math.max(0, next.stops.length - 1));
        this.host.write(next, "own");
      });
      return item;
    });
    menu.addEventListener("keydown", (e: Event) => {
      const ev = e as KeyboardEvent;
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.closeMenu();
        this.presetsButton.focus();
      }
    });
    items[0]?.focus();
  }

  private closeMenu(): void {
    this.root.ownerDocument?.removeEventListener?.("pointerdown", this.pressOutside, true);
    this.menu?.remove();
    this.menu = null;
    this.presetsButton.setAttribute("aria-expanded", "false");
  }

  /** The pointer's offset along the slider (0-1), and how far below it, in CSS px; null where the slider is not laid out. */
  private measure(ev: PointerEvent): { offset: number; below: number } | null {
    const rect = typeof this.track.getBoundingClientRect === "function" ? this.track.getBoundingClientRect() : null;
    if (!rect || rect.width <= 0) return null;
    return { offset: pointerOffset((ev.clientX - rect.left) / rect.width), below: ev.clientY - rect.bottom };
  }

  /** A press on the bar: a stop there, in the ramp's colour there, selected. */
  private addAt(ev: PointerEvent): void {
    if (ev.button !== undefined && ev.button !== 0) return;
    const at = this.measure(ev);
    const ramp = this.host.read();
    if (!at || !ramp) return;
    ev.preventDefault?.();
    const added = addStop(ramp, at.offset);
    this.state.selected = added.index;
    this.host.write(added.ramp, "own");
  }

  private startDrag(ev: PointerEvent, index: number): void {
    if (ev.button !== undefined && ev.button !== 0) return;
    this.drag = { index, started: false, off: false };
    this.select(index);
    try {
      this.track.setPointerCapture?.(ev.pointerId);
    } catch {
      // A pointer that is gone already: the drag still ends on its release.
    }
  }

  /** A drag's move: the stop follows the pointer (its first write a "start", the rest "continue"); pulled off below, it is only marked. */
  private moveDrag(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const at = this.measure(ev);
    const ramp = this.host.read();
    if (!at || !ramp) return;
    drag.off = ramp.stops.length > 1 && at.below > DROP_OFF_PX;
    this.handleEls[drag.index]?.toggleClass("lf-ramp-handle-off", drag.off);
    if (drag.off || ramp.stops[drag.index]?.offset === at.offset) return;
    const moved = moveStop(ramp, drag.index, at.offset);
    const step: UndoStep = drag.started ? "continue" : "start";
    drag.started = true;
    drag.index = moved.index;
    this.state.selected = moved.index;
    this.host.write(moved.ramp, step);
  }

  /** The release: a handle pulled off is removed (in the drag's undo step), and the step ends. */
  private endDrag(ev: PointerEvent, released: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    try {
      if (this.track.hasPointerCapture?.(ev.pointerId)) this.track.releasePointerCapture(ev.pointerId);
    } catch {
      // Already released.
    }
    const ramp = this.host.read();
    if (released && drag.off && ramp && ramp.stops.length > 1) {
      this.state.selected = Math.min(drag.index, ramp.stops.length - 2);
      this.host.write(removeStop(ramp, drag.index), drag.started ? "continue" : "start");
      drag.started = true;
    } else this.handleEls[drag.index]?.toggleClass("lf-ramp-handle-off", false);
    if (drag.started) this.host.endMerge?.();
  }

  private onKey(ev: KeyboardEvent, index: number): void {
    const ramp = this.host.read();
    const stop = ramp?.stops[index];
    if (!ramp || !stop) return;
    const step = ev.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let to: number | null = null;
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") to = stop.offset + step;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") to = stop.offset - step;
    else if (ev.key === "Home") to = 0;
    else if (ev.key === "End") to = 1;
    else if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      this.state.selected = index;
      this.removeSelected(true);
      return;
    } else return;
    ev.preventDefault();
    const moved = moveStop(ramp, index, Math.round(to * 1000) / 1000);
    this.state.selected = moved.index;
    this.state.refocus = true;
    // A run of nudges merges into one undo step, as the store merges a field's quick edits.
    this.host.write(moved.ramp);
    if (this.state.refocus) this.focusSelected();
  }
}
