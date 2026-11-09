import { CURATED_FONTS, DEFAULT_FONT } from "../constants";
import { compareFamilies } from "../fonts/family-list";
import { boxAttachable } from "../model/attach";
import type { Rect } from "../model/geometry";
import type { DocumentStore } from "../model/store";
import type { TextNode } from "../model/types";
import type { Field } from "../registry/fields";
import type { InspectorContext, NodeRenderer, NodeType, RenderContext, SvgContext } from "../registry/node-type";
import { COLOR_PATTERN, fieldError, type ParamSpec } from "../registry/params";
import { textNodePptx } from "./text-node-pptx";
import { textNodeSvg } from "./text-node-svg";

export { textNodeSvg };

export const CURATED_FONT_OPTIONS: { value: string; label: string }[] = CURATED_FONTS.map((family) => ({ value: family, label: family }));

/** The Font menu: the installed families, or the curated six while there are none; the node's own family is always in it. */
function fontOptions(families: string[] | null, current: string): { value: string; label: string }[] {
  const base = families && families.length > 0 ? families.map((family) => ({ value: family, label: family })) : CURATED_FONT_OPTIONS;
  if (base.some((o) => o.value === current)) return base;
  // The same family spelt in another case (fonts match case-insensitively) is that entry, carrying the node's spelling.
  const folded = current.toLowerCase();
  const same = base.findIndex((o) => o.value.toLowerCase() === folded);
  if (same >= 0) return base.map((o, i) => (i === same ? { value: current, label: o.label } : o));
  // Installed families are sorted; the node's own is put where it sorts. The curated six keep their order, with it last.
  const withCurrent = [...base, { value: current, label: current }];
  return families && families.length > 0 ? withCurrent.sort((a, b) => compareFamilies(a.value, b.value)) : withCurrent;
}

const WEIGHT_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "bold", label: "Bold" },
];

const ALIGN_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

/** The part of the figure view (`RenderContext.component`) that editing text goes through. */
interface EditingView {
  store: Pick<DocumentStore, "commit">;
  readOnly: boolean;
}

/**
 * One text node's DOM: `.lf-node` holding `.lf-node-body` holding `.lf-text`, which shows the text as it is (line
 * breaks and spaces kept) in the node's font. Double-clicking it edits the text in place (the double-click arrives as
 * `dblclick` on the text or as `lf-activate` on the node, see the constructor): plain text only, committed when the
 * element loses focus, abandoned with Escape.
 */
class TextNodeRenderer implements NodeRenderer {
  private node: TextNode;
  private readonly el: HTMLElement;
  private readonly textEl: HTMLElement;

  /** Whether `textEl` is being typed into. Its text is then the user's, and a change of the node's does not overwrite it. */
  private editing = false;
  /** The node's text when editing began: what Escape goes back to, and what tells that anything was typed. */
  private before = "";

  constructor(node: TextNode, host: HTMLElement, private readonly ctx: RenderContext) {
    this.node = node;
    this.el = host.createDiv({ cls: "lf-node" });
    this.textEl = this.el.createDiv({ cls: "lf-node-body" }).createDiv({ cls: "lf-text" });
    this.textEl.style.whiteSpace = "pre-wrap";
    this.textEl.style.overflow = "hidden";
    // The pointer controller leaves presses and keys on an editable element to it, so these need no `stopPropagation`.
    this.textEl.addEventListener("dblclick", () => this.beginEdit());
    // The same, from the pointer controller: its press captured the pointer, so the double-click that follows reaches the
    // stage and not this element, and the controller finds the node in the model and tells it so.
    this.el.addEventListener("lf-activate", () => this.beginEdit());
    this.textEl.addEventListener("blur", () => this.endEdit());
    this.textEl.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    this.update(node);
  }

  update(node: TextNode): void {
    this.node = node;
    this.applyBox();
    this.applyFont();
    if (!this.editing) this.syncText();
  }

  unmount(): void {
    // The node is gone (deleted, undone, reloaded): whatever was being typed has nowhere to go, and removing the element must not commit it.
    this.editing = false;
    this.el.remove();
  }

  private applyBox(): void {
    const n = this.node;
    const style = this.el.style;
    style.left = `${n.x}px`;
    style.top = `${n.y}px`;
    style.width = `${n.width}px`;
    style.height = `${n.height}px`;
    style.zIndex = String(n.z);
    style.transform = n.rotation === 0 ? "" : `rotate(${n.rotation}deg)`;
    style.opacity = n.opacity === 1 ? "" : String(n.opacity);
  }

  private applyFont(): void {
    const font = this.node.font;
    const style = this.textEl.style;
    style.fontFamily = font.family;
    style.fontSize = `${font.size}pt`;
    style.fontWeight = font.weight;
    style.fontStyle = font.italic ? "italic" : "normal";
    style.color = font.color;
    style.textAlign = font.align;
    style.lineHeight = String(font.lineHeight);
  }

  /** Shows the node's text, as text and never as markup. */
  private syncText(): void {
    if (this.textEl.textContent !== this.node.text) this.textEl.textContent = this.node.text;
  }

  /** The figure view, or null when there is none to edit through. */
  private view(): EditingView | null {
    const view = this.ctx.component as unknown as Partial<EditingView>;
    return view.store && typeof view.store.commit === "function" ? (view as EditingView) : null;
  }

  private beginEdit(): void {
    if (this.editing || this.node.locked) return;
    const view = this.view();
    if (!view || view.readOnly) return;
    this.editing = true;
    this.before = this.node.text;
    const el = this.textEl;
    el.setAttribute("contenteditable", "plaintext-only");
    el.focus({ preventScroll: true });
    const selection = el.ownerDocument.defaultView?.getSelection();
    if (selection) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  /** Leaves edit mode and returns what was typed. The caller decides what becomes of it. */
  private leaveEdit(): string {
    this.editing = false;
    const el = this.textEl;
    const typed = el.innerText.replace(/\r\n?/g, "\n");
    // What was selected for typing is not to stay highlighted on the page.
    const selection = el.ownerDocument.defaultView?.getSelection();
    if (selection?.anchorNode && el.contains(selection.anchorNode)) selection.removeAllRanges();
    el.removeAttribute("contenteditable");
    return typed;
  }

  /** The element lost the focus (a click elsewhere, a toolbar button, another window): what was typed is kept, if it is anything. */
  private endEdit(): void {
    if (!this.editing) return;
    const typed = this.leaveEdit();
    // Compared with what editing began with, not with the node now: a change made elsewhere meanwhile (an undo) is not the user's to put back.
    if (typed !== this.before) this.commit(typed);
    // What the model holds is what is shown, whether or not the commit changed it (the node may be gone, or the view read-only).
    this.syncText();
  }

  private cancelEdit(): void {
    if (!this.editing) return;
    this.leaveEdit();
    this.syncText();
    // Keys are the stage's again, as after a click on it.
    const stage = this.el.closest<HTMLElement>(".lf-stage");
    if (stage) stage.focus({ preventScroll: true });
    else this.textEl.blur();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (!this.editing || ev.isComposing || ev.key !== "Escape") return;
    // Escape is the edit's. It must not go on to the stage, which would take it as "deselect" now that the element is no longer editable.
    ev.preventDefault();
    ev.stopPropagation();
    this.cancelEdit();
  }

  private commit(text: string): void {
    const id = this.node.id;
    // Looked up when it is needed: the view may have swapped in another store since this element was made.
    this.view()?.store.commit("text", (draft) => {
      const node = draft.nodes.find((n) => n.id === id);
      if (node?.type === "text") node.text = text;
    });
  }
}

/** What `node.update` checks of a text node's own fields. */
const TEXT_FIELDS: ParamSpec = {
  text: { type: "string" },
  font: {
    type: "object",
    properties: {
      family: { type: "string" },
      size: { type: "number", exclusiveMinimum: 0 },
      weight: { type: "string", enum: ["normal", "bold"] },
      italic: { type: "boolean" },
      color: { type: "string", pattern: COLOR_PATTERN },
      align: { type: "string", enum: ["left", "center", "right"] },
      lineHeight: { type: "number", exclusiveMinimum: 0 },
    },
  },
};

/** A label: text set in one font, for the letters and captions of a figure. */
export const textNodeType: NodeType<TextNode> = {
  type: "text",
  name: "Text",
  icon: "type",

  mount(node: TextNode, host: HTMLElement, ctx: RenderContext): NodeRenderer {
    return new TextNodeRenderer(node, host, ctx);
  },

  bounds(node: TextNode): Rect {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  },

  inspector(node: TextNode, ctx?: InspectorContext): Field[] {
    return [
      { kind: "select", key: "font.family", label: "Font", options: fontOptions(ctx?.fontFamilies?.() ?? null, node.font.family) },
      { kind: "number", key: "font.size", label: "Size", unit: "pt", min: 1, step: 0.5 },
      { kind: "select", key: "font.weight", label: "Weight", options: WEIGHT_OPTIONS },
      { kind: "toggle", key: "font.italic", label: "Italic" },
      { kind: "color", key: "font.color", label: "Color" },
      { kind: "select", key: "font.align", label: "Align", options: ALIGN_OPTIONS },
      { kind: "number", key: "font.lineHeight", label: "Line height", min: 0.5, step: 0.1 },
    ];
  },

  /** Its box, rotated: anchors `n e s w`. */
  attachable: boxAttachable,

  /** A font that lacks some of its fields (one given whole) has the default font's for them, as a file's is read. */
  completeUpdate(_before: TextNode, after: TextNode): TextNode {
    const font: unknown = after.font;
    if (typeof font !== "object" || font === null || Array.isArray(font)) return after;
    return { ...after, font: { ...DEFAULT_FONT, ...after.font } };
  },

  checkField: (key, value) => fieldError(TEXT_FIELDS, key, value),

  toSvg(node: TextNode, ctx: SvgContext): string {
    return textNodeSvg(node, ctx);
  },

  toPptx: textNodePptx,
};
