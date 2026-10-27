/** Just enough of an element, with Obsidian's `createEl` helpers, to build and drive generated panels without a browser. */
export interface FakeDocument {
  activeElement: FakeEl | null;
}

export interface ElInfo {
  cls?: string | string[];
  text?: string;
  type?: string;
  value?: string;
  attr?: Record<string, string | number | boolean | null>;
}

export class FakeEl {
  cls: string[] = [];
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  text = "";
  type = "";
  value = "";
  checked = false;
  disabled = false;
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(readonly tag: string, readonly ownerDocument: FakeDocument = { activeElement: null }) {}

  createEl(tag: string, info: ElInfo = {}): FakeEl {
    const el = new FakeEl(tag, this.ownerDocument);
    if (info.cls) el.cls = Array.isArray(info.cls) ? info.cls : [info.cls];
    if (info.text !== undefined) el.text = info.text;
    if (info.type !== undefined) el.type = info.type;
    if (info.value !== undefined) el.value = info.value;
    for (const [k, v] of Object.entries(info.attr ?? {})) if (v !== null) el.attrs[k] = String(v);
    this.children.push(el);
    return el;
  }

  createDiv(info?: ElInfo): FakeEl {
    return this.createEl("div", info);
  }

  createSpan(info?: ElInfo): FakeEl {
    return this.createEl("span", info);
  }

  empty(): void {
    this.children = [];
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  /** What the browser does when the user does something to the control. */
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  get valueAsNumber(): number {
    return this.value === "" ? NaN : Number(this.value);
  }

  /** Only `[data-key="..."]`, which is all the inspector asks for. */
  querySelector<T = FakeEl>(selector: string): T | null {
    const key = /^\[data-key="(.*)"\]$/.exec(selector)?.[1];
    return (this.find((el) => key !== undefined && el.attrs["data-key"] === key) as unknown as T) ?? null;
  }

  find(test: (el: FakeEl) => boolean): FakeEl | null {
    for (const child of this.children) {
      if (test(child)) return child;
      const found = child.find(test);
      if (found) return found;
    }
    return null;
  }

  findAll(test: (el: FakeEl) => boolean): FakeEl[] {
    return this.children.flatMap((child) => [...(test(child) ? [child] : []), ...child.findAll(test)]);
  }

  hasClass(name: string): boolean {
    return this.cls.includes(name);
  }

  /** The control for a field. */
  control(key: string): FakeEl {
    const el = this.querySelector(`[data-key="${key}"]`);
    if (!el) throw new Error(`no control for ${key}`);
    return el;
  }

  /** The user types `text` into a text-like control, without committing it yet. */
  typeOnly(key: string, text: string): FakeEl {
    const el = this.control(key);
    el.focus();
    el.value = text;
    el.fire("input");
    return el;
  }

  /** The user types `text` into a text-like control and commits it (Enter, or leaving it). */
  typeInto(key: string, text: string): void {
    this.typeOnly(key, text).fire("change");
  }
}
