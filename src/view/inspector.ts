import { prepareCall, runInOneCommit, type PreparedCall } from "../commands/headless";
import { mmToPx, pxToMm } from "../model/geometry";
import type { Node, NodeId, Page, Paint } from "../model/types";
import { childrenOf } from "../model/groups";
import { getPreset } from "../model/presets";
import type { Field } from "../registry/fields";
import type { InspectorContext } from "../registry/node-type";
import type { Registries } from "../registry";
import type { LinkFiguresView } from "./figure-view";
import { CUSTOM_PRESET, nodeBaseFields, pageFields, readValue, writeValue } from "./page-fields";
import { roundPx } from "./pointer-math";

/** Numbers are shown to hundredths: a node's millimetres come from pixels and would otherwise trail digits. */
export function formatNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** `n` kept within the field's `min` and `max`, where it has them. */
export function clampToField(field: Field, n: number): number {
  let value = n;
  if (field.min !== undefined) value = Math.max(field.min, value);
  if (field.max !== undefined) value = Math.min(field.max, value);
  return value;
}

/** A colour as a colour input takes it (`#rrggbb`); black for one it cannot show (a name, or nothing). */
export function colorInputValue(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() : "#000000";
}

type Control = HTMLInputElement | HTMLSelectElement;

/** The text and number controls that have been typed into and not yet committed: what is in them is the user's, not the model's. */
const typedInto = new WeakSet<Control>();

/** The checkbox beside a `nullable` colour input: whether there is a colour at all. */
const nullToggles = new WeakMap<Control, HTMLInputElement>();

function setControlValue(control: Control, field: Field, value: unknown): void {
  if (field.kind === "toggle") (control as HTMLInputElement).checked = field.onValue !== undefined ? value !== null && value !== undefined : value === true;
  else if (field.kind === "number") control.value = typeof value === "number" && Number.isFinite(value) ? formatNumber(value) : "";
  else if (field.kind === "color" && field.nullable) {
    const present = typeof value === "string";
    const toggle = nullToggles.get(control);
    if (toggle) toggle.checked = present;
    (control as HTMLInputElement).disabled = !present;
    // With no colour, the input keeps the one it last showed: turning the colour back on brings that one back.
    if (present) control.value = colorInputValue(value);
  } else if (field.kind === "color") control.value = colorInputValue(value);
  else control.value = typeof value === "string" ? value : "";
}

/** What generated fields need besides their values: the registries (the paint types, for a `paint` field). The inspector passes its node types' context. */
export interface FieldEnv {
  registries?: Pick<Registries, "paints">;
}

type Read = (key: string) => unknown;
type Write = (key: string, value: unknown) => void;

/**
 * A field made of other fields (`paint`, `stops`), drawn into its holder. Which controls it has depends on its value
 * (the paint's type, the number of stops): `shape` names them, and when it changes the holder is drawn again.
 */
interface Composite {
  shape(): string;
  drawn: string;
  draw(): void;
  sync(): void;
}

const composites = new WeakMap<HTMLElement, Composite>();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A composite field's holder brought in line with its value: drawn again when its controls should be others, otherwise its controls synced. */
function syncComposite(holder: HTMLElement): void {
  const composite = composites.get(holder);
  if (!composite) return;
  if (composite.shape() !== composite.drawn) composite.draw();
  else composite.sync();
}

/**
 * A `paint` field: a select of the registered paint types, then the chosen type's own fields, their keys under the
 * field's (`stroke.paint.color`). Choosing a type writes that type's `defaults()` as the whole paint. A paint whose type
 * is not registered is listed as it is, with no fields, and stays as it is until another type is chosen.
 */
function paintComposite(holder: HTMLElement, field: Field, read: Read, write: Write, env: FieldEnv): Composite {
  const paintOf = (): Paint | undefined => {
    const value = read(field.key);
    return isRecord(value) && typeof value.type === "string" ? (value as Paint) : undefined;
  };
  const subFields = (): Field[] => {
    const paint = paintOf();
    const type = paint ? env.registries?.paints.get(paint.type) : undefined;
    return paint && type ? type.fields(paint).map((f) => ({ ...f, key: `${field.key}.${f.key}` })) : [];
  };
  const composite: Composite = {
    shape: () => `${paintOf()?.type ?? ""}|${subFields().map((f) => `${f.kind}:${f.key}`).join(",")}`,
    drawn: "",
    draw() {
      composite.drawn = composite.shape();
      holder.empty();
      const current = paintOf()?.type;
      const select = holder.createEl("select", { cls: "dropdown", attr: { "data-key": `${field.key}.type` } });
      const types = env.registries?.paints.all() ?? [];
      for (const type of types) select.createEl("option", { value: type.id, text: type.name });
      if (current !== undefined && !types.some((t) => t.id === current)) select.createEl("option", { value: current, text: `${current} (not available)` });
      select.value = current ?? "";
      select.addEventListener("change", () => {
        const type = env.registries?.paints.get(select.value);
        if (type && type.id !== paintOf()?.type) write(field.key, type.defaults());
        syncComposite(holder);
        select.value = paintOf()?.type ?? "";
      });
      renderFields(holder, subFields(), read, write, env);
    },
    sync() {
      const select = holder.querySelector<HTMLSelectElement>(`[data-key="${field.key}.type"]`);
      if (select) select.value = paintOf()?.type ?? "";
      syncFields(holder, subFields(), read, env);
    },
  };
  return composite;
}

/**
 * A `stops` field: one row per gradient stop (offset, colour, opacity, under keys `stops.0.offset`…), each with a remove
 * button, and an add button. A gradient keeps at least two stops; a stop is added between the last two, in the last one's colour.
 */
function stopsComposite(holder: HTMLElement, field: Field, read: Read, write: Write, env: FieldEnv): Composite {
  const stops = (): unknown[] => {
    const value = read(field.key);
    return Array.isArray(value) ? value : [];
  };
  const rowFields = (i: number): Field[] => [
    { kind: "number", key: `${field.key}.${i}.offset`, label: "Offset", min: 0, max: 1, step: 0.05 },
    { kind: "color", key: `${field.key}.${i}.color`, label: "Color" },
    { kind: "number", key: `${field.key}.${i}.opacity`, label: "Opacity", min: 0, max: 1, step: 0.05 },
  ];
  const allFields = (): Field[] => stops().flatMap((_, i) => rowFields(i));
  const composite: Composite = {
    shape: () => String(stops().length),
    drawn: "",
    draw() {
      composite.drawn = composite.shape();
      holder.empty();
      const count = stops().length;
      for (let i = 0; i < count; i++) {
        const row = holder.createDiv({ cls: "lf-stop" });
        renderFields(row, rowFields(i), read, write, env);
        const remove = row.createEl("button", { cls: "lf-stop-remove", text: "Remove", attr: { type: "button" } });
        remove.disabled = count <= 2;
        remove.addEventListener("click", () => {
          const current = stops();
          if (current.length <= 2) return;
          write(field.key, current.filter((_, j) => j !== i));
          syncComposite(holder);
        });
      }
      const add = holder.createEl("button", { cls: "lf-stop-add", text: "Add stop", attr: { type: "button" } });
      add.addEventListener("click", () => {
        const current = stops();
        const n = current.length;
        const at = (i: number): Record<string, unknown> => (isRecord(current[i]) ? current[i] : {});
        const offset = (i: number, fallback: number): number => (typeof at(i).offset === "number" ? (at(i).offset as number) : fallback);
        const color = typeof at(n - 1).color === "string" ? (at(n - 1).color as string) : "#000000";
        // Between the last two stops; with fewer, at the end that is free.
        const stop = { offset: n >= 2 ? (offset(n - 2, 0) + offset(n - 1, 1)) / 2 : n === 0 ? 0 : 1, color };
        write(field.key, n >= 2 ? [...current.slice(0, n - 1), stop, current[n - 1]] : [...current, stop]);
        syncComposite(holder);
      });
    },
    sync() {
      syncFields(holder, allFields(), read, env);
    },
  };
  return composite;
}

/** The `<input>` type of each field kind that is one input. */
const INPUT_TYPES: Partial<Record<Field["kind"], string>> = { number: "number", text: "text", color: "color", toggle: "checkbox" };

const COMPOSITES: Partial<Record<Field["kind"], (holder: HTMLElement, field: Field, read: Read, write: Write, env: FieldEnv) => Composite>> = {
  paint: paintComposite,
  stops: stopsComposite,
};

/**
 * One `.lf-field` row per field: a label and the control its `kind` calls for. `read` gives the value to show and
 * `write` is told what the user sets; numbers are passed on as the user reads them (in the field's `unit`), kept
 * within `min` and `max`. Text, numbers and selects write when they are committed (Enter, leaving the field), colours
 * as they are picked. A `paint` or `stops` field is a group of such rows (see `paintComposite`, `stopsComposite`). A
 * toggle with an `onValue`, and a `nullable` colour, write null for "none" (see `Field`).
 */
export function renderFields(container: HTMLElement, fields: Field[], read: Read, write: Write, env: FieldEnv = {}): void {
  for (const field of fields) {
    const makeComposite = COMPOSITES[field.kind];
    if (makeComposite) {
      const row = container.createDiv({ cls: ["lf-field", "lf-field-group"] });
      row.createSpan({ cls: "lf-field-label", text: field.label });
      const holder = row.createDiv({ cls: "lf-field-control", attr: { "data-key": field.key } });
      const composite = makeComposite(holder, field, read, write, env);
      composites.set(holder, composite);
      composite.draw();
      continue;
    }
    // A label row hands a click anywhere in it to its first control. A nullable colour's first control is its
    // checkbox, which a stray click must not flip (it writes the document), so that row is a plain div.
    const nullable = field.kind === "color" && field.nullable === true;
    const row = container.createEl(nullable ? "div" : "label", { cls: "lf-field" });
    row.createSpan({ cls: "lf-field-label", text: field.label });
    const holder = row.createDiv({ cls: "lf-field-control" });
    const attr = { "data-key": field.key };

    // A nullable colour's checkbox comes before its colour input, and is not the field's control (`data-key`).
    const nullToggle = nullable ? holder.createEl("input", { type: "checkbox", cls: "lf-null-toggle", attr: { "aria-label": `${field.label}: on or off` } }) : null;
    let control: Control;
    if (field.kind === "select") {
      control = holder.createEl("select", { cls: "dropdown", attr });
      for (const option of field.options ?? []) control.createEl("option", { value: option.value, text: option.label });
    } else {
      const type = INPUT_TYPES[field.kind];
      const numeric = field.kind === "number";
      control = holder.createEl("input", {
        type,
        attr: {
          ...attr,
          ...(numeric ? { step: field.step ?? "any" } : {}),
          ...(numeric && field.min !== undefined ? { min: field.min } : {}),
          ...(numeric && field.max !== undefined ? { max: field.max } : {}),
        },
      });
    }
    if (field.unit) holder.createSpan({ cls: "lf-unit", text: field.unit });

    if (nullToggle) nullToggles.set(control, nullToggle);
    const show = (): void => setControlValue(control, field, read(field.key));
    show();
    if (nullToggle) {
      nullToggle.addEventListener("change", () => {
        write(field.key, nullToggle.checked ? colorInputValue(control.value) : null);
        show();
      });
    }
    if (field.kind === "color") {
      // Live while the picker is dragged; the store merges the run of commits into one undo step.
      control.addEventListener("input", () => write(field.key, control.value));
      continue;
    }
    if (field.kind === "number" || field.kind === "text") {
      control.addEventListener("input", () => typedInto.add(control));
      // Leaving the field with nothing committed (typed, then put back) shows the model's value again.
      control.addEventListener("blur", () => {
        typedInto.delete(control);
        show();
      });
    }
    const commit = (): void => {
      typedInto.delete(control);
      if (field.kind === "toggle") {
        const checked = (control as HTMLInputElement).checked;
        write(field.key, field.onValue === undefined ? checked : checked ? structuredClone(field.onValue) : null);
      }
      else if (field.kind === "number") {
        const n = (control as HTMLInputElement).valueAsNumber;
        // Nothing, or something that is not a number: the value that was there comes back.
        if (!Number.isNaN(n)) write(field.key, clampToField(field, n));
      } else write(field.key, control.value);
      // What the model kept (clamped, rounded, refused) is what is shown.
      show();
    };
    // What Enter committed: the browser still sends `change` for it when the field is left, and that must not write again.
    let enterCommitted: string | null = null;
    control.addEventListener("input", () => (enterCommitted = null));
    control.addEventListener("change", () => {
      if (enterCommitted !== null && enterCommitted === control.value) {
        enterCommitted = null;
        return;
      }
      commit();
    });
    if (field.kind === "number" || field.kind === "text") {
      // Enter commits like leaving the field does; the default action (a second `change`) is cancelled so it is written once.
      control.addEventListener("keydown", (e: Event) => {
        const ev = e as KeyboardEvent;
        if (ev.key !== "Enter" || ev.isComposing) return;
        ev.preventDefault();
        commit();
        enterCommitted = control.value;
      });
    }
  }
}

/**
 * Sets the controls `renderFields` made from the current values, leaving alone one that is being typed into. A `paint`
 * or `stops` field whose controls should now be others (another paint type, another number of stops) is drawn again.
 */
export function syncFields(container: HTMLElement, fields: Field[], read: Read, env: FieldEnv = {}): void {
  for (const field of fields) {
    const control = container.querySelector<Control>(`[data-key="${field.key}"]`);
    if (!control) continue;
    if (COMPOSITES[field.kind]) syncComposite(control as unknown as HTMLElement);
    else if (!typedInto.has(control)) setControlValue(control, field, read(field.key));
  }
}

/** What the inspector shows: a titled list of fields and how to read and write them. */
interface Section {
  title: string;
  subtitle?: string;
  /** Equal signatures mean the same controls: the section is then updated in place instead of being built again. */
  signature: string;
  fields: Field[];
  read(key: string): unknown;
  write(key: string, value: unknown): void;
}

/**
 * The right-hand panel, generated from fields. With nothing selected it shows the page nearest the middle of the stage (`focusPage`);
 * with nodes selected it shows the first one's fields (the base fields and its node type's), and writes go to every
 * selected node. A node's write runs the `node.update` command for each node it changes, all in one commit labelled
 * `inspect:<key>`, so a run of edits to one field is one undo step, and the inspector makes the same documents as a
 * script that sends the same patches; a write the command refuses is shown as a notice and changes nothing. A page's
 * write runs `page.update` the same way (which cuts a size down to the page limit and says so), and a field that its
 * node type routes to a command of its own (`NodeType.fieldRoute`, a file panel's crop insets) runs that command.
 * Values are shown as the user thinks of them: a node's position and size in millimetres, though it stores pixels.
 */
export class Inspector {
  private signature = "";
  /** A change of section is waiting for the control being typed into to lose the focus. */
  private pending = false;

  /** `onWriteFailed` is told what went wrong when a write was refused (the view shows it as a notice). */
  constructor(
    private readonly view: LinkFiguresView,
    private readonly el: HTMLElement,
    private readonly onWriteFailed: (message: string) => void = () => {},
  ) {
    // `change` has committed the field's write by the time the focus leaves it, so the section that was held back is then drawn.
    this.el.addEventListener("focusout", () => {
      if (this.pending) this.render();
    });
  }

  render(): void {
    const section = this.describe();
    if (!section) {
      this.pending = false;
      this.signature = "";
      this.el.empty();
      return;
    }
    // The stage moved to another page while a field here was being typed into: rebuilding the panel would take the field, and what was typed, away.
    if (section.signature !== this.signature && this.isTypingIn()) {
      this.pending = true;
      return;
    }
    this.pending = false;
    // The same controls as before (a store change that is none of their business, or the user's own edit): only their values change, so a field being typed in keeps its text and focus.
    if (section.signature === this.signature) {
      syncFields(this.el, section.fields, section.read, this.context());
      return;
    }
    this.signature = section.signature;
    this.el.empty();
    this.el.createDiv({ cls: "lf-inspector-title", text: section.title });
    if (section.subtitle) this.el.createDiv({ cls: "lf-inspector-sub", text: section.subtitle });
    renderFields(this.el.createDiv({ cls: "lf-fields" }), section.fields, section.read, section.write, this.context());
  }

  /**
   * One context for the node types' fields and for drawing them: the plugin's registries, and what the view shows of a
   * node's image now (whether it shows one, and its size), which the crop fields depend on.
   */
  private context(): InspectorContext {
    const view = this.view as Partial<Pick<LinkFiguresView, "imageSizeNow" | "imageStateNow" | "samplesNow">>;
    return {
      registries: this.view.plugin.registries,
      imageSizeNow: (id) => view.imageSizeNow?.(id) ?? null,
      imageStateNow: (id) => view.imageStateNow?.(id) ?? null,
      samplesNow: (id) => view.samplesNow?.(id) ?? null,
    };
  }

  /** A control in this inspector has the focus and holds text that has not been committed. */
  private isTypingIn(): boolean {
    const active = this.el.ownerDocument?.activeElement;
    return !!active && this.el.contains(active) && typedInto.has(active as Control);
  }

  /**
   * Runs `calls`, a write of the field `key` (one of `fields`, or a part of one), in one commit labelled `inspect:<key>`.
   * One that is refused leaves the document as it was, and says so in a notice naming the field and why.
   */
  private runWrite(key: string, fields: readonly Field[], calls: PreparedCall[]): void {
    try {
      runInOneCommit(this.view.store, this.view.commandContext(), calls, `inspect:${key}`);
    } catch (error) {
      const label = fields.find((f) => f.key === key)?.label ?? key;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Link Figures: the inspector could not set "${key}"`, error);
      this.onWriteFailed(`Link Figures: could not change ${label}: ${reason}`);
    }
  }

  private describe(): Section | null {
    // A file that could not be read has nothing to inspect.
    if (this.view.readOnly) return null;
    const present = new Set(this.view.store.doc.nodes.map((n) => n.id));
    const selected = this.view.selection.ids.filter((id) => present.has(id));
    return selected.length > 0 ? this.nodeSection(selected) : this.pageSection();
  }

  private pageSection(): Section | null {
    const page = this.view.focusPage();
    if (!page) return null;
    const id = page.id;
    const live = () => this.view.store.doc.pages.find((p) => p.id === id);
    const fields = pageFields();
    return {
      title: "Page",
      subtitle: page.name,
      signature: `page:${id}:${page.name}`,
      fields,
      read: (key) => {
        const current = live();
        if (!current) return undefined;
        // A preset that is not one of ours (an edited file) is shown as custom, which is what it is.
        if (key === "preset") return current.preset !== undefined && getPreset(current.preset) ? current.preset : CUSTOM_PRESET;
        return readValue(current, key);
      },
      write: (key, value) => {
        const current = live();
        if (!current) return;
        const call = prepareCall(this.view.plugin.registries, { id: "page.update", args: { id, patch: patchFor(current, key, value) } });
        this.runWrite(key, fields, [call]);
      },
    };
  }

  private nodeSection(ids: readonly NodeId[]): Section | null {
    const nodes = this.view.store.doc.nodes;
    const first = nodes.find((n) => n.id === ids[0]);
    if (!first) return null;
    const type = this.view.plugin.registries.nodeTypes.get(first.type);
    const derived = new Set(type?.derivedFields ?? []);
    const base = nodeBaseFields().filter((f) => !derived.has(f.key));
    const baseKeys = new Set(base.map((f) => f.key));
    const fields = [...base, ...(type?.inspector(first, this.context()) ?? [])];
    // Pixels in the file, millimetres on screen.
    const mm = new Set(fields.filter((f) => f.unit === "mm").map((f) => f.key));
    const paintKeys = fields.filter((f) => f.kind === "paint").map((f) => f.key);
    const targets = new Set(ids);
    const live = () => this.view.store.doc.nodes.find((n) => n.id === first.id);
    // A group (a type that has members) is titled with its type's name and how many direct members it has.
    const members = ids.length === 1 && type?.members ? childrenOf(this.view.store.doc, first.id).length : null;
    const title = ids.length > 1 ? `${ids.length} nodes` : members !== null ? `${type?.name ?? "Group"} (${members} items)` : "Node";
    return {
      title,
      subtitle: ids.length > 1 || members !== null ? undefined : type?.name,
      signature: `node:${ids.join(",")}:${fields.map((f) => f.key).join(",")}:${title}`,
      fields,
      read: (key) => {
        const node = live();
        // A field its type writes through a command of its own (a crop inset) is read the type's way too.
        const route = type?.fieldRoute?.(key);
        if (route) return node ? route.read(node, this.context()) : undefined;
        const value = node ? readValue(node, key) : undefined;
        return mm.has(key) && typeof value === "number" ? pxToMm(value) : value;
      },
      write: (key, value) => {
        const route = type?.fieldRoute?.(key);
        if (route) {
          // One call of the type's command per selected node of the type, in one commit, as `node.update` writes are.
          const ctx = this.context();
          const routed = this.view.store.doc.nodes
            .filter((node) => targets.has(node.id) && node.type === first.type && (route.applies?.(node, this.view.store.doc, ctx) ?? true))
            .map((node) => prepareCall(this.view.plugin.registries, route.call(node, value, ctx)));
          if (routed.length > 0) this.runWrite(key, fields, routed);
          return;
        }
        const stored = mm.has(key) && typeof value === "number" ? roundPx(mmToPx(value)) : value;
        // A locked node is written too: asking for it in the inspector is explicit.
        const parent = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : null;
        // A paint's own field (`frame.paint.color`) belongs to the first node's paint type, and is not written onto a paint of another.
        const paintKey = paintKeys.find((p) => key.startsWith(`${p}.`));
        const doc = this.view.store.doc;
        const firstNow = doc.nodes.find((n) => n.id === first.id);
        const paintType = paintKey && firstNow ? readValue(firstNow, `${paintKey}.type`) : undefined;
        const calls: PreparedCall[] = [];
        for (const node of doc.nodes) {
          if (!targets.has(node.id)) continue;
          // What belongs to one node type is not written onto nodes of another.
          if (!baseKeys.has(key) && node.type !== first.type) continue;
          // Nor is a nested value written onto a node that has nothing there (a frame that is off).
          if (parent !== null && !isRecord(readValue(node, parent)) && !Array.isArray(readValue(node, parent))) continue;
          if (paintKey && readValue(node, `${paintKey}.type`) !== paintType) continue;
          calls.push(prepareCall(this.view.plugin.registries, { id: "node.update", args: { id: node.id, patch: patchFor(node, key, stored) } }));
        }
        if (calls.length === 0) return;
        this.runWrite(key, fields, calls);
      },
    };
  }
}

/**
 * The `node.update` (or `page.update`) patch that sets `key` (a dotted path, `border.width`, `caps.0.kind`) of `target`,
 * a node or a page, to `value`: the whole top-level field with that one value changed, so a list (the caps, a gradient's
 * stops) is written whole, as the update commands write lists. An empty `name` is passed on as it is: `node.update`
 * removes the name.
 */
export function patchFor(target: Node | Page, key: string, value: unknown): Record<string, unknown> {
  const copy = (v: unknown): unknown => (typeof v === "object" && v !== null ? structuredClone(v) : v);
  const dot = key.indexOf(".");
  if (dot === -1) return { [key]: copy(value) };
  const top = key.slice(0, dot);
  const field = copy((target as unknown as Record<string, unknown>)[top]) as object;
  writeValue(field, key.slice(dot + 1), copy(value));
  return { [top]: field };
}
