import { Window } from "happy-dom";

/** What Obsidian's `createEl` and its kin take. */
interface ElInfo {
  cls?: string | string[];
  text?: string;
  type?: string;
  value?: string;
  attr?: Record<string, string | number | boolean | null>;
}

/**
 * A happy-dom window whose elements have the helpers Obsidian adds to `HTMLElement` (`createEl`, `createDiv`,
 * `createSpan`, `empty`, `setText`, `toggleClass`, `hasClass`), so that the inspector's generated panels can be built
 * and driven in a real DOM: focus, events that bubble, `role` and `aria-*` attributes.
 */
export function obsidianWindow(): Window {
  const window = new Window();
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.createEl = function (this: HTMLElement, tag: string, info: ElInfo = {}) {
    const el = this.ownerDocument.createElement(tag) as HTMLElement & { type?: string; value?: string };
    const classes = Array.isArray(info.cls) ? info.cls : info.cls ? info.cls.split(" ") : [];
    for (const c of classes) if (c) el.classList.add(c);
    if (info.text !== undefined) el.textContent = info.text;
    if (info.type !== undefined) el.setAttribute("type", info.type);
    for (const [k, v] of Object.entries(info.attr ?? {})) if (v !== null) el.setAttribute(k, String(v));
    if (info.value !== undefined) el.value = info.value;
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: { createEl(tag: string, info?: ElInfo): unknown }, info?: ElInfo) {
    return this.createEl("div", info);
  };
  proto.createSpan = function (this: { createEl(tag: string, info?: ElInfo): unknown }, info?: ElInfo) {
    return this.createEl("span", info);
  };
  proto.empty = function (this: HTMLElement) {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  proto.setText = function (this: HTMLElement, text: string) {
    this.textContent = text;
  };
  proto.toggleClass = function (this: HTMLElement, name: string, on: boolean) {
    this.classList.toggle(name, on);
  };
  proto.hasClass = function (this: HTMLElement, name: string) {
    return this.classList.contains(name);
  };
  return window;
}
