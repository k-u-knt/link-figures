import type { Rect } from "../../../model/geometry";
import { ContentParseError, type Token } from "./tokenize";

/**
 * The drawings of a PDF content stream that can be removed one by one, each with a conservative box: a path from its
 * first construction operator through its painting operator, a `Do`, an inline image, a `sh`, and a whole `BT … ET`.
 * The graphics state is interpreted only as far as needed to place them. A unit's byte range holds its operands and
 * operators and never a state operator whose effect is needed after it, so removing it leaves the state as it was.
 * When a box cannot be known for certain it is `null`, and the unit is never removed.
 */

/** A PDF matrix [a b c d e f], mapping (x, y) to (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

/** What the units need to know about the resources the stream names. */
export interface ResourceInfo {
  xobject(name: string): { subtype: "Form"; bbox: [number, number, number, number]; matrix: Matrix } | { subtype: "Image" } | null;
  /** A font's horizontal widths (in thousandths of an em), or null for a font that must not be measured. */
  font(name: string): { widths: { first: number; list: number[]; missing: number } | null; twoByte: boolean } | null;
  shadingBBox(name: string): [number, number, number, number] | null;
}

/**
 * A removable drawing: the bytes [start, end) of the stream, and its box in the space `ctm` maps into (page user space
 * at the top level, y up), or null when unknown. `name` is the XObject's or shading's resource name; `ctm` is the CTM
 * in effect where the unit stands.
 */
export interface Unit {
  start: number;
  end: number;
  box: Rect | null;
  kind: "path" | "text" | "xobject" | "inlineImage" | "shading";
  name?: string;
  ctm?: Matrix;
}

type Operand =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "name"; value: string }
  | { kind: "array"; items: Operand[] }
  | { kind: "other" };

/** One operator with its operands, covering the bytes [start, end): from its first operand to the operator's end. */
interface Op {
  name: string;
  operands: Operand[];
  start: number;
  end: number;
}

/** The parts of the graphics state that persist past a text object, as far as removing one has to care. */
type StateKey =
  | "font" | "Tc" | "Tw" | "Tz" | "TL" | "Ts" | "Tr"
  | "fillSpace" | "fillColor" | "strokeSpace" | "strokeColor"
  | "w" | "J" | "j" | "M" | "d" | "ri" | "i";

const FILL: StateKey[] = ["fillSpace", "fillColor"];
const STROKE: StateKey[] = ["strokeSpace", "strokeColor"];
const LINE: StateKey[] = ["w", "J", "j", "M", "d"];
const MISC: StateKey[] = ["ri", "i"];
const ALL: StateKey[] = ["font", "Tc", "Tw", "Tz", "TL", "Ts", "Tr", ...FILL, ...STROKE, ...LINE, ...MISC];

/** What each operator reads and writes of the state above. An operator not listed reads everything. */
const EFFECTS: Record<string, { reads: StateKey[]; writes: StateKey[] }> = {};
function effect(names: string, reads: StateKey[], writes: StateKey[]): void {
  for (const name of names.split(" ")) EFFECTS[name] = { reads, writes };
}
effect("q Q cm gs BT ET Td Tm m l c v y re h n W W* BMC BDC EMC MP DP BX EX d0 d1", [], []);
effect("f F f*", [...FILL, ...MISC], []);
effect("S s", [...STROKE, ...LINE, ...MISC], []);
effect("B B* b b*", [...FILL, ...STROKE, ...LINE, ...MISC], []);
effect("Tj TJ ' \" Do BI sh", ALL, []);
effect("T*", ["TL"], []);
effect("TD", [], ["TL"]);
effect("Tf", [], ["font"]);
for (const key of ["Tc", "Tw", "Tz", "TL", "Ts", "Tr", "w", "J", "j", "M", "d", "ri", "i"] as const) effect(key, [], [key]);
effect("cs g rg k", [], FILL);
effect("CS G RG K", [], STROKE);
effect("sc scn", ["fillSpace"], ["fillColor"]);
effect("SC SCN", ["strokeSpace"], ["strokeColor"]);

const PATH_CONSTRUCTION = new Set(["m", "l", "c", "v", "y", "re", "h"]);
const FILL_PAINT = new Set(["f", "F", "f*"]);
const STROKE_PAINT = new Set(["S", "s", "B", "B*", "b", "b*"]);
const CLOSING_PAINT = new Set(["s", "b", "b*"]);

/** The operators a text object may hold and still be measured (ISO 32000-1 figure 9), besides those that show text. */
const TEXT_ALLOWED = new Set([
  "Tc", "Tw", "Tz", "TL", "Tf", "Tr", "Ts", "Td", "TD", "Tm", "T*",
  "cs", "CS", "sc", "scn", "SC", "SCN", "g", "G", "rg", "RG", "k", "K",
  "w", "J", "j", "M", "d", "ri", "i",
  "BMC", "BDC", "EMC", "MP", "DP", "BX", "EX",
]);
const TEXT_SHOWING = new Set(["Tj", "TJ", "'", '"']);

/**
 * Text box: from 0.5 em below the baseline to 1.2 em above it, and 0.5 em beyond each end of a showing operator's
 * glyphs, so that descenders, accents and ink past the advance width (italics, swashes) stay inside.
 */
const TEXT_DESCENT = -0.5;
const TEXT_ASCENT = 1.2;
const TEXT_SIDE = 0.5;

/** Ratios within this (relative) of the miter limit are taken as mitered, to err on the larger box. */
const MITER_SLACK = 1e-9;

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` then `b`: the matrix a PDF writes as a × b. */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The largest factor by which `m` stretches any length (its largest singular value). */
function maxScale(m: Matrix): number {
  const s = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const det = m[0] * m[3] - m[1] * m[2];
  return Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2);
}

/** The box of points given as [x0, y0, x1, y1, …], each widened by `r`. */
function boxOf(points: number[], r = 0): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  if (!(minX <= maxX && minY <= maxY)) return null;
  const box = { x: minX - r, y: minY - r, width: maxX - minX + 2 * r, height: maxY - minY + 2 * r };
  return [box.x, box.y, box.width, box.height].every(Number.isFinite) ? box : null;
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** The box of the rectangle [x0 y0 x1 y1] through `m`. */
function rectThrough(m: Matrix, x0: number, y0: number, x1: number, y1: number): Rect | null {
  return boxOf([...apply(m, x0, y0), ...apply(m, x1, y0), ...apply(m, x0, y1), ...apply(m, x1, y1)]);
}

/** Groups tokens into operators with their operands. Throws on unbalanced brackets or operands with no operator. */
function readOps(tokens: Token[]): Op[] {
  const ops: Op[] = [];
  let operands: Operand[] = [];
  let start = -1;
  /** Open arrays and dictionaries, innermost last. */
  const open: { kind: "array" | "dict"; items: Operand[] }[] = [];
  const push = (operand: Operand, token: Token) => {
    if (open.length) open[open.length - 1].items.push(operand);
    else {
      if (start < 0) start = token.start;
      operands.push(operand);
    }
  };
  for (const token of tokens) {
    switch (token.kind) {
      case "number":
        push({ kind: "number", value: Number(token.value) }, token);
        break;
      case "string":
      case "hexstring":
        push({ kind: "string", value: token.value }, token);
        break;
      case "name":
        push({ kind: "name", value: token.value }, token);
        break;
      case "arrayStart":
      case "dictStart":
        if (!open.length && start < 0) start = token.start;
        open.push({ kind: token.kind === "arrayStart" ? "array" : "dict", items: [] });
        break;
      case "arrayEnd":
      case "dictEnd": {
        const closing = open.pop();
        if (!closing || closing.kind !== (token.kind === "arrayEnd" ? "array" : "dict")) {
          throw new ContentParseError(`Unbalanced "${token.value}" at byte ${token.start}`);
        }
        push(closing.kind === "array" ? { kind: "array", items: closing.items } : { kind: "other" }, token);
        break;
      }
      case "operator":
        if (token.value === "true" || token.value === "false" || token.value === "null") {
          push({ kind: "other" }, token);
          break;
        }
        if (open.length) throw new ContentParseError(`Operator "${token.value}" inside brackets at byte ${token.start}`);
        ops.push({ name: token.value, operands, start: start < 0 ? token.start : start, end: token.end });
        operands = [];
        start = -1;
        break;
      case "inlineImage":
        if (open.length || operands.length) throw new ContentParseError(`Inline image after operands at byte ${token.start}`);
        ops.push({ name: "BI", operands: [], start: token.start, end: token.end });
        break;
    }
  }
  if (open.length || operands.length) throw new ContentParseError("Operands with no operator at the end of the stream");
  return ops;
}

function numbers(op: Op, count: number): number[] {
  if (op.operands.length !== count || op.operands.some((o) => o.kind !== "number" || !Number.isFinite(o.value))) {
    throw new ContentParseError(`"${op.name}" needs ${count} numbers at byte ${op.start}`);
  }
  return op.operands.map((o) => (o as { value: number }).value);
}

function nameOperand(op: Op): string {
  const o = op.operands[0];
  if (op.operands.length !== 1 || o.kind !== "name") throw new ContentParseError(`"${op.name}" needs a name at byte ${op.start}`);
  return o.value;
}

function stringOperand(o: Operand | undefined, op: Op): string {
  if (!o || o.kind !== "string") throw new ContentParseError(`"${op.name}" needs a string at byte ${op.start}`);
  return o.value;
}

interface GState {
  ctm: Matrix;
  lineWidth: number;
  cap: number;
  join: number;
  miterLimit: number;
  font: string | null;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  /** Horizontal scaling as a factor (Tz / 100). */
  scale: number;
  leading: number;
  rise: number;
  render: number;
}

/** A path under construction: its points and miter tips in the target space, and its subpath in user space for joins. */
interface PathBuild {
  start: number;
  points: number[];
  tips: number[];
  clip: boolean;
  known: boolean;
  /** The current subpath's start, current point, and first and last directions (unit vectors), in user space. */
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  first: [number, number] | null;
  last: [number, number] | null;
}

interface TextBuild {
  start: number;
  box: Rect | null;
  known: boolean;
  shown: boolean;
  markedDepth: number;
  depth: number;
  writes: Set<StateKey>;
}

/**
 * The removable units of a content stream, in stream order. `ctm` is the CTM the stream starts with: identity for a
 * page, the form's matrix times the CTM of its `Do` for a form XObject.
 */
export function findUnits(tokens: Token[], bytes: Uint8Array, resources: ResourceInfo, ctm: Matrix): Unit[] {
  for (const t of tokens) {
    if (t.start < 0 || t.end > bytes.length || t.start > t.end) throw new ContentParseError("Token outside the stream");
  }
  const ops = readOps(tokens);
  const units: Unit[] = [];
  /** Text units whose box depends on the state they set not being used after them. */
  const textChecks: { unit: Unit; next: number; depth: number; writes: Set<StateKey> }[] = [];

  let gs: GState = {
    ctm: [...ctm], lineWidth: 1, cap: 0, join: 0, miterLimit: 10,
    font: null, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0, render: 0,
  };
  const saved: GState[] = [];
  let path: PathBuild | null = null;
  let text: TextBuild | null = null;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const fonts = new Map<string, ReturnType<ResourceInfo["font"]>>();
  /** Per two-byte font: the width each byte counts as, the widest known glyph but at least an em. */
  const twoByteWidths = new Map<string, number>();

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const name = op.name;

    if (text) {
      if (name === "ET") {
        const box = text.known && text.shown && text.markedDepth === 0 ? text.box : null;
        const unit: Unit = { start: text.start, end: op.end, box, kind: "text", ctm: [...gs.ctm] };
        units.push(unit);
        if (box && text.writes.size) textChecks.push({ unit, next: index + 1, depth: text.depth, writes: text.writes });
        text = null;
        continue;
      }
      if (name === "BT") throw new ContentParseError(`Nested BT at byte ${op.start}`);
      if (TEXT_SHOWING.has(name)) showText(op);
      else if (!TEXT_ALLOWED.has(name)) text.known = false;
      else {
        if (name === "BMC" || name === "BDC") text.markedDepth++;
        if (name === "EMC" && --text.markedDepth < 0) text.known = false;
        for (const key of EFFECTS[name]?.writes ?? []) text.writes.add(key);
      }
      // Path construction inside a text object is not followed: the object is already unknown.
      if (!PATH_CONSTRUCTION.has(name) && !FILL_PAINT.has(name) && !STROKE_PAINT.has(name) && !["n", "W", "W*"].includes(name)) {
        applyState(op);
      }
      continue;
    }

    if (path) {
      if (PATH_CONSTRUCTION.has(name)) {
        construct(op);
        continue;
      }
      if (name === "W" || name === "W*") {
        path.clip = true;
        continue;
      }
      if (name === "n" || FILL_PAINT.has(name) || STROKE_PAINT.has(name)) {
        paint(op);
        continue;
      }
      if (name === "BT" || name === "Do" || name === "sh" || name === "BI") {
        throw new ContentParseError(`"${name}" inside a path at byte ${op.start}`);
      }
      // Any other operator inside a path: the path stays drawn but its range is not removed.
      path.known = false;
      applyState(op);
      continue;
    }

    if (PATH_CONSTRUCTION.has(name)) {
      path = { start: op.start, points: [], tips: [], clip: false, known: true, sx: 0, sy: 0, cx: 0, cy: 0, first: null, last: null };
      construct(op);
    } else if (name === "BT") {
      text = { start: op.start, box: null, known: true, shown: false, markedDepth: 0, depth: saved.length, writes: new Set() };
      tm = IDENTITY;
      tlm = IDENTITY;
    } else if (name === "ET") {
      throw new ContentParseError(`ET without BT at byte ${op.start}`);
    } else if (name === "Do") {
      const xname = nameOperand(op);
      const info = resources.xobject(xname);
      let box: Rect | null = null;
      if (info?.subtype === "Form") box = rectThrough(multiply(info.matrix, gs.ctm), ...info.bbox);
      else if (info?.subtype === "Image") box = rectThrough(gs.ctm, 0, 0, 1, 1);
      units.push({ start: op.start, end: op.end, box, kind: "xobject", name: xname, ctm: [...gs.ctm] });
    } else if (name === "BI") {
      units.push({ start: op.start, end: op.end, box: rectThrough(gs.ctm, 0, 0, 1, 1), kind: "inlineImage", ctm: [...gs.ctm] });
    } else if (name === "sh") {
      const sname = nameOperand(op);
      const bbox = resources.shadingBBox(sname);
      const box = bbox ? rectThrough(gs.ctm, ...bbox) : null;
      units.push({ start: op.start, end: op.end, box, kind: "shading", name: sname, ctm: [...gs.ctm] });
    } else applyState(op);
  }
  if (text) throw new ContentParseError("BT without ET at the end of the stream");

  for (const check of textChecks) {
    if (stateUsedAfter(ops, check.next, check.depth, check.writes)) check.unit.box = null;
  }
  return units;

  /** Interprets an operator that changes the graphics or text state (and passes over any other). */
  function applyState(op: Op): void {
    switch (op.name) {
      case "q":
        saved.push(gs);
        gs = { ...gs, ctm: [...gs.ctm] };
        break;
      case "Q":
        // An unbalanced Q is ignored, as readers do.
        if (saved.length) gs = saved.pop()!;
        break;
      case "cm":
        gs.ctm = multiply(numbers(op, 6) as Matrix, gs.ctm);
        break;
      case "w":
        gs.lineWidth = Math.abs(numbers(op, 1)[0]);
        break;
      case "J":
        gs.cap = numbers(op, 1)[0];
        break;
      case "j":
        gs.join = numbers(op, 1)[0];
        break;
      case "M":
        gs.miterLimit = numbers(op, 1)[0];
        break;
      case "Tc":
        gs.charSpacing = numbers(op, 1)[0];
        break;
      case "Tw":
        gs.wordSpacing = numbers(op, 1)[0];
        break;
      case "Tz":
        gs.scale = numbers(op, 1)[0] / 100;
        break;
      case "TL":
        gs.leading = numbers(op, 1)[0];
        break;
      case "Ts":
        gs.rise = numbers(op, 1)[0];
        break;
      case "Tr":
        gs.render = numbers(op, 1)[0];
        break;
      case "Tf": {
        const font = op.operands[0];
        const size = op.operands[1];
        if (op.operands.length !== 2 || font.kind !== "name" || size.kind !== "number" || !Number.isFinite(size.value)) {
          throw new ContentParseError(`"Tf" needs a name and a size at byte ${op.start}`);
        }
        gs.font = font.value;
        gs.size = size.value;
        break;
      }
      case "Td": {
        const [tx, ty] = numbers(op, 2);
        tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm;
        break;
      }
      case "TD": {
        const [tx, ty] = numbers(op, 2);
        gs.leading = -ty;
        tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm;
        break;
      }
      case "Tm":
        tlm = numbers(op, 6) as Matrix;
        tm = tlm;
        break;
      case "T*":
        numbers(op, 0);
        nextLine();
        break;
    }
  }

  function nextLine(): void {
    tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
    tm = tlm;
  }

  /** A text-showing operator: moves the text matrix and adds the glyphs' box to the text object's. */
  function showText(op: Op): void {
    const t = text!;
    let items: Operand[];
    if (op.name === "Tj") {
      if (op.operands.length !== 1) throw new ContentParseError(`"Tj" needs one string at byte ${op.start}`);
      stringOperand(op.operands[0], op);
      items = op.operands;
    } else if (op.name === "'") {
      if (op.operands.length !== 1) throw new ContentParseError(`"'" needs one string at byte ${op.start}`);
      stringOperand(op.operands[0], op);
      nextLine();
      items = op.operands;
    } else if (op.name === '"') {
      const [aw, ac, s] = op.operands;
      if (op.operands.length !== 3 || aw.kind !== "number" || ac.kind !== "number") {
        throw new ContentParseError(`'"' needs two numbers and a string at byte ${op.start}`);
      }
      stringOperand(s, op);
      gs.wordSpacing = aw.value;
      gs.charSpacing = ac.value;
      t.writes.add("Tw");
      t.writes.add("Tc");
      nextLine();
      items = [s];
    } else {
      const array = op.operands[0];
      if (op.operands.length !== 1 || array.kind !== "array" || array.items.some((o) => o.kind !== "number" && o.kind !== "string")) {
        throw new ContentParseError(`"TJ" needs an array of strings and numbers at byte ${op.start}`);
      }
      items = array.items;
    }

    // Render modes 4–7 add the glyphs to the clipping path, which outlives the text object.
    if (gs.render >= 4 || gs.render < 0 || gs.font === null) {
      t.known = false;
      return;
    }
    let font = fonts.get(gs.font);
    if (font === undefined) {
      font = resources.font(gs.font);
      fonts.set(gs.font, font);
    }
    if (!font) {
      t.known = false;
      return;
    }
    const size = gs.size;
    const th = gs.scale;
    // A two-byte font's codes are not mapped to glyphs here: each byte counts as a glyph at least one em wide.
    let twoByteWidth = twoByteWidths.get(gs.font);
    if (twoByteWidth === undefined) {
      twoByteWidth = Math.max(1000, font.widths?.missing ?? 0);
      for (const w of font.widths?.list ?? []) if (w > twoByteWidth) twoByteWidth = w;
      twoByteWidths.set(gs.font, twoByteWidth);
    }
    let x = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const item of items) {
      if (item.kind === "number") {
        x -= (item.value / 1000) * size * th;
        continue;
      }
      const codes = (item as { value: string }).value;
      for (let i = 0; i < codes.length; i++) {
        const code = codes.charCodeAt(i);
        const w0 = font.twoByte ? twoByteWidth : !font.widths ? 1000 : (font.widths.list[code - font.widths.first] ?? font.widths.missing);
        const ink = (w0 / 1000) * size * th;
        minX = Math.min(minX, x, x + ink);
        maxX = Math.max(maxX, x, x + ink);
        const spacing = gs.charSpacing + (!font.twoByte && code === 32 ? gs.wordSpacing : 0);
        x += ((w0 / 1000) * size + spacing) * th;
      }
    }
    if (minX <= maxX) {
      const y0 = Math.min(TEXT_DESCENT * size, TEXT_ASCENT * size) + gs.rise;
      const y1 = Math.max(TEXT_DESCENT * size, TEXT_ASCENT * size) + gs.rise;
      const side = Math.abs(TEXT_SIDE * size * th);
      let box = rectThrough(multiply(tm, gs.ctm), minX - side, y0, maxX + side, y1);
      // Modes 1 and 2 stroke the glyph outlines.
      if (box && (gs.render === 1 || gs.render === 2)) {
        const half = (gs.lineWidth / 2) * maxScale(gs.ctm);
        box = { x: box.x - half, y: box.y - half, width: box.width + 2 * half, height: box.height + 2 * half };
      }
      if (!box) t.known = false;
      t.box = union(t.box, box);
      t.shown = true;
    }
    tm = multiply([1, 0, 0, 1, x, 0], tm);
  }

  /** A path construction operator: its points go into the path's box, its joins into the miter tips. */
  function construct(op: Op): void {
    const p = path!;
    const addPoint = (x: number, y: number) => p.points.push(...apply(gs.ctm, x, y));
    const moveTo = (x: number, y: number) => {
      Object.assign(p, { sx: x, sy: y, cx: x, cy: y, first: null, last: null });
      addPoint(x, y);
    };
    /** A segment from the current point leaving along `out` and arriving along `into` at (x, y). */
    const segment = (out: [number, number] | null, into: [number, number] | null, x: number, y: number) => {
      if (out && into) {
        if (p.last) miterTip(p.cx, p.cy, p.last, out);
        else p.first = out;
        p.last = into;
      }
      p.cx = x;
      p.cy = y;
    };
    const close = () => {
      segment(direction(p.cx, p.cy, p.sx, p.sy), direction(p.cx, p.cy, p.sx, p.sy), p.sx, p.sy);
      if (p.last && p.first) miterTip(p.sx, p.sy, p.last, p.first);
      Object.assign(p, { cx: p.sx, cy: p.sy, first: null, last: null });
    };
    const curve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
      addPoint(x1, y1);
      addPoint(x2, y2);
      addPoint(x3, y3);
      const out = direction(p.cx, p.cy, x1, y1) ?? direction(p.cx, p.cy, x2, y2) ?? direction(p.cx, p.cy, x3, y3);
      const into = direction(x2, y2, x3, y3) ?? direction(x1, y1, x3, y3) ?? direction(p.cx, p.cy, x3, y3);
      segment(out, into, x3, y3);
    };
    const begun = p.points.length > 0;
    switch (op.name) {
      case "m": {
        const [x, y] = numbers(op, 2);
        moveTo(x, y);
        break;
      }
      case "l": {
        const [x, y] = numbers(op, 2);
        if (!begun) moveTo(x, y);
        addPoint(x, y);
        const d = direction(p.cx, p.cy, x, y);
        segment(d, d, x, y);
        break;
      }
      case "c": {
        const n = numbers(op, 6);
        if (!begun) moveTo(n[0], n[1]);
        curve(n[0], n[1], n[2], n[3], n[4], n[5]);
        break;
      }
      case "v": {
        const [x2, y2, x3, y3] = numbers(op, 4);
        if (!begun) moveTo(x2, y2);
        curve(p.cx, p.cy, x2, y2, x3, y3);
        break;
      }
      case "y": {
        const [x1, y1, x3, y3] = numbers(op, 4);
        if (!begun) moveTo(x1, y1);
        curve(x1, y1, x3, y3, x3, y3);
        break;
      }
      case "re": {
        const [x, y, w, h] = numbers(op, 4);
        moveTo(x, y);
        for (const [px, py] of [[x + w, y], [x + w, y + h], [x, y + h]]) {
          addPoint(px, py);
          const d = direction(p.cx, p.cy, px, py);
          segment(d, d, px, py);
        }
        close();
        break;
      }
      case "h":
        numbers(op, 0);
        if (begun) close();
        break;
    }
  }

  /** Where a miter join at (vx, vy) between directions `into` and `out` reaches, when the join is mitered. */
  function miterTip(vx: number, vy: number, into: [number, number], out: [number, number]): void {
    if (gs.join !== 0) return;
    const sinHalf = Math.sqrt(Math.max(0, (1 + into[0] * out[0] + into[1] * out[1]) / 2));
    if (sinHalf === 0 || 1 / sinHalf > gs.miterLimit * (1 + MITER_SLACK)) return;
    const bisector = direction(out[0], out[1], into[0], into[1]);
    if (!bisector) return;
    const reach = gs.lineWidth / 2 / sinHalf;
    path!.tips.push(...apply(gs.ctm, vx + bisector[0] * reach, vy + bisector[1] * reach));
  }

  /** A painting operator (or `n`) ends the path; a painted path that does not clip is a unit. */
  function paint(op: Op): void {
    const p = path!;
    if (op.name === "n" || p.clip) {
      path = null;
      return;
    }
    if (CLOSING_PAINT.has(op.name)) {
      // Closing the last subpath adds its joins (its points are all in already).
      if (p.last) {
        const d = direction(p.cx, p.cy, p.sx, p.sy);
        if (d) {
          miterTip(p.cx, p.cy, p.last, d);
          if (p.first) miterTip(p.sx, p.sy, d, p.first);
        } else if (p.first) miterTip(p.sx, p.sy, p.last, p.first);
      }
    }
    path = null;
    let box: Rect | null = null;
    if (p.known) {
      if (STROKE_PAINT.has(op.name)) {
        // Round and butt ends stay within half the line width; projecting caps reach it diagonally.
        const half = (gs.lineWidth / 2) * maxScale(gs.ctm) * (gs.cap === 2 ? Math.SQRT2 : 1);
        box = union(boxOf(p.points, half), boxOf(p.tips));
      } else box = boxOf(p.points);
    }
    units.push({ start: p.start, end: op.end, box, kind: "path", ctm: [...gs.ctm] });
  }
}

/** The unit vector from (x0, y0) to (x1, y1), or null when they are the same point. */
function direction(x0: number, y0: number, x1: number, y1: number): [number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  return len > 0 && Number.isFinite(len) ? [dx / len, dy / len] : null;
}

/**
 * Whether any of `writes` (made by a text object ending just before `ops[from]`, at q-depth `depth`) is read by a later
 * operator before it is written again at that depth, or restored by the `Q` that ends that depth. If so, removing the
 * text object would change what is drawn after it.
 */
function stateUsedAfter(ops: Op[], from: number, depth: number, writes: Set<StateKey>): boolean {
  const pending = new Set(writes);
  let level = depth;
  for (let i = from; i < ops.length; i++) {
    const name = ops[i].name;
    if (name === "q") {
      level++;
      continue;
    }
    if (name === "Q") {
      if (level === 0) continue;
      if (level === depth) return false;
      level--;
      continue;
    }
    const e = EFFECTS[name] ?? { reads: ALL, writes: [] };
    if (e.reads.some((key) => pending.has(key))) return true;
    if (level === depth) for (const key of e.writes) pending.delete(key);
    if (!pending.size) return false;
  }
  return false;
}
