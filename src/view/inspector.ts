import { DEFAULT_PAGE_LIMIT_MM } from "../constants";
import { mmToPx, pxToMm } from "../model/geometry";
import type { NodeId } from "../model/types";
import { getPreset } from "../model/presets";
import type { Field } from "../registry/fields";
import type { LinkFiguresView } from "./figure-view";
import { CUSTOM_PRESET, nodeBaseFields, pageFields, readValue, writePageField, writeValue } from "./page-fields";
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

function setControlValue(control: Control, field: Field, value: unknown): void {
  if (field.kind === "toggle") (control as HTMLInputElement).checked = value === true;
  else if (field.kind === "number") control.value = typeof value === "number" && Number.isFinite(value) ? formatNumber(value) : "";
  else if (field.kind === "color") control.value = colorInputValue(value);
  else control.value = typeof value === "string" ? value : "";
}

/**
 * One `.lf-field` row per field: a label and the control its `kind` calls for. `read` gives the value to show and
 * `write` is told what the user sets; numbers are passed on as the user reads them (in the field's `unit`), kept
 * within `min` and `max`. Text, numbers and selects write when they are committed (Enter, leaving the field), colours
 * as they are picked.
 */
export function renderFields(container: HTMLElement, fields: Field[], read: (key: string) => unknown, write: (key: string, value: unknown) => void): void {
  for (const field of fields) {
    const row = container.createEl("label", { cls: "lf-field" });
    row.createSpan({ cls: "lf-field-label", text: field.label });
    const holder = row.createDiv({ cls: "lf-field-control" });
    const attr = { "data-key": field.key };

    let control: Control;
    if (field.kind === "select") {
      control = holder.createEl("select", { cls: "dropdown", attr });
      for (const option of field.options ?? []) control.createEl("option", { value: option.value, text: option.label });
    } else {
      const type = { number: "number", text: "text", color: "color", toggle: "checkbox" }[field.kind];
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

    const show = (): void => setControlValue(control, field, read(field.key));
    show();
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
    control.addEventListener("change", () => {
      typedInto.delete(control);
      if (field.kind === "toggle") write(field.key, (control as HTMLInputElement).checked);
      else if (field.kind === "number") {
        const n = (control as HTMLInputElement).valueAsNumber;
        // Nothing, or something that is not a number: the value that was there comes back.
        if (!Number.isNaN(n)) write(field.key, clampToField(field, n));
      } else write(field.key, control.value);
      // What the model kept (clamped, rounded, refused) is what is shown.
      show();
    });
  }
}

/** Sets the controls `renderFields` made from the current values, leaving alone one that is being typed into. */
export function syncFields(container: HTMLElement, fields: Field[], read: (key: string) => unknown): void {
  for (const field of fields) {
    const control = container.querySelector<Control>(`[data-key="${field.key}"]`);
    if (control && !typedInto.has(control)) setControlValue(control, field, read(field.key));
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
 * selected node. Every write is a commit labelled `inspect:<key>`, so a run of edits to one field is one undo step.
 * Values are shown as the user thinks of them: a node's position and size in millimetres, though it stores pixels.
 */
export class Inspector {
  private signature = "";
  /** A change of section is waiting for the control being typed into to lose the focus. */
  private pending = false;

  /** `onPageLimit` is told the limit when a page edit had to be cut down to it (the view shows a notice). */
  constructor(
    private readonly view: LinkFiguresView,
    private readonly el: HTMLElement,
    private readonly onPageLimit: (limitMm: number) => void = () => {},
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
      syncFields(this.el, section.fields, section.read);
      return;
    }
    this.signature = section.signature;
    this.el.empty();
    this.el.createDiv({ cls: "lf-inspector-title", text: section.title });
    if (section.subtitle) this.el.createDiv({ cls: "lf-inspector-sub", text: section.subtitle });
    renderFields(this.el.createDiv({ cls: "lf-fields" }), section.fields, section.read, section.write);
  }

  /** A control in this inspector has the focus and holds text that has not been committed. */
  private isTypingIn(): boolean {
    const active = this.el.ownerDocument?.activeElement;
    return !!active && this.el.contains(active) && typedInto.has(active as Control);
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
    return {
      title: "Page",
      subtitle: page.name,
      signature: `page:${id}:${page.name}`,
      fields: pageFields(),
      read: (key) => {
        const current = live();
        if (!current) return undefined;
        // A preset that is not one of ours (an edited file) is shown as custom, which is what it is.
        if (key === "preset") return current.preset !== undefined && getPreset(current.preset) ? current.preset : CUSTOM_PRESET;
        return readValue(current, key);
      },
      write: (key, value) => {
        const limit = this.view.plugin.settings?.maxPageSizeMm ?? DEFAULT_PAGE_LIMIT_MM;
        let clamped = false;
        this.view.store.commit(`inspect:${key}`, (draft) => {
          const target = draft.pages.find((p) => p.id === id);
          if (target) clamped = writePageField(target, key, value, limit);
        });
        if (clamped) this.onPageLimit(limit);
      },
    };
  }

  private nodeSection(ids: readonly NodeId[]): Section | null {
    const nodes = this.view.store.doc.nodes;
    const first = nodes.find((n) => n.id === ids[0]);
    if (!first) return null;
    const type = this.view.plugin.registries.nodeTypes.get(first.type);
    const base = nodeBaseFields();
    const baseKeys = new Set(base.map((f) => f.key));
    const fields = [...base, ...(type?.inspector(first) ?? [])];
    // Pixels in the file, millimetres on screen.
    const mm = new Set(fields.filter((f) => f.unit === "mm").map((f) => f.key));
    const targets = new Set(ids);
    const live = () => this.view.store.doc.nodes.find((n) => n.id === first.id);
    return {
      title: ids.length > 1 ? `${ids.length} nodes` : "Node",
      subtitle: ids.length > 1 ? undefined : type?.name,
      signature: `node:${ids.join(",")}:${fields.map((f) => f.key).join(",")}`,
      fields,
      read: (key) => {
        const node = live();
        const value = node ? readValue(node, key) : undefined;
        return mm.has(key) && typeof value === "number" ? pxToMm(value) : value;
      },
      write: (key, value) => {
        const stored = mm.has(key) && typeof value === "number" ? roundPx(mmToPx(value)) : value;
        // A locked node is written too: asking for it in the inspector is explicit.
        this.view.store.commit(`inspect:${key}`, (draft) => {
          for (const node of draft.nodes) {
            if (!targets.has(node.id)) continue;
            // What belongs to one node type is not written onto nodes of another.
            if (!baseKeys.has(key) && node.type !== first.type) continue;
            if (key === "name" && stored === "") delete node.name;
            else writeValue(node, key, stored);
          }
        });
      },
    };
  }
}
