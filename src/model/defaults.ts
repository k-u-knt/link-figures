import { DEFAULT_FONT, MM_TO_PX } from "../constants";
import { mmToPx } from "./geometry";
import { getPreset } from "./presets";
import { DEFAULT_CAP_SIZE } from "../registry/cap";
import type { Cap, ConnectorNode, Document, FileNode, GroupNode, Page, ShapeNode, Stroke, TextNode } from "./types";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 4;

/** `p` for nodes, `pg` for pages: `<prefix>-<4 chars of [a-z0-9]>`, not already in `existing`. */
export function newId(prefix: "p" | "pg" | "g", existing: Iterable<string>): string {
  const taken = new Set(existing);
  let id: string;
  do {
    let suffix = "";
    for (let i = 0; i < ID_LENGTH; i++) suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    id = `${prefix}-${suffix}`;
  } while (taken.has(id));
  return id;
}

/** `existingIds` are the ids of the pages already in the document; unnamed pages are numbered after them. */
export function createPage(presetId: string, existingIds: Iterable<string>, name?: string): Page {
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`Unknown page preset: ${presetId}`);
  const ids = [...existingIds];
  return {
    id: newId("pg", ids),
    name: name ?? `Page ${ids.length + 1}`,
    preset: preset.id,
    width: preset.width,
    height: preset.height,
    paper: "#ffffff",
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    grid: { spacing: 5, show: false },
  };
}

export function createDocument(presetId: string): Document {
  return { version: 1, pages: [createPage(presetId, [], "Page 1")], nodes: [], edges: [] };
}

export function fileNodeDefaults(
  page: Page,
  partial: Partial<FileNode> & Pick<FileNode, "file" | "subpath" | "show">,
  existingIds: Iterable<string>,
): FileNode {
  return {
    id: newId("p", existingIds),
    type: "file",
    page: page.id,
    x: 0,
    y: 0,
    width: 0.4 * page.width * MM_TO_PX,
    height: 0.25 * page.height * MM_TO_PX,
    z: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    imageIndex: 0,
    crop: null,
    fit: "cover",
    pageIndex: 0,
    range: "auto",
    scale: 1,
    frame: null,
    adjustments: [],
    ...partial,
  };
}

export function textNodeDefaults(page: Page, partial: Partial<TextNode>, existingIds: Iterable<string>): TextNode {
  return {
    id: newId("p", existingIds),
    type: "text",
    page: page.id,
    x: 0,
    y: 0,
    width: mmToPx(30),
    height: mmToPx(10),
    z: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    text: "Text",
    font: { ...DEFAULT_FONT },
    ...partial,
  };
}

/** The border a shape starts with, and gets back when its border is turned on: 1 pt solid black. */
export function defaultBorder(): Stroke {
  return { paint: { type: "solid", color: "#000000" }, width: 1, dash: "solid" };
}

/** A 30 × 20 mm rectangle, filled white, with the default border. */
export function shapeNodeDefaults(page: Page, partial: Partial<ShapeNode>, existingIds: Iterable<string>): ShapeNode {
  return {
    id: newId("p", existingIds),
    type: "shape",
    page: page.id,
    x: 0,
    y: 0,
    width: mmToPx(30),
    height: mmToPx(20),
    z: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    kind: "rect",
    params: { cornerRadius: 0 },
    fill: { type: "solid", color: "#ffffff" },
    border: defaultBorder(),
    ...partial,
  };
}

/** The caps a connector starts with: none at the start, an arrowhead at the end. */
export function defaultCaps(): [Cap, Cap] {
  return [
    { kind: "none", size: DEFAULT_CAP_SIZE },
    { kind: "arrow", size: DEFAULT_CAP_SIZE },
  ];
}

/**
 * A straight 1 pt solid black arrow from (0, 0) to (0, 0), unless `partial` says otherwise. Its box is a placeholder:
 * the store's connector normaliser sets it to the area the connector draws in the commit that adds it.
 */
export function connectorNodeDefaults(page: Page, partial: Partial<ConnectorNode>, existingIds: Iterable<string>): ConnectorNode {
  return {
    id: newId("p", existingIds),
    type: "connector",
    page: page.id,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    z: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    ends: [
      { kind: "free", x: 0, y: 0 },
      { kind: "free", x: 0, y: 0 },
    ],
    route: "straight",
    routeParams: {},
    stroke: defaultBorder(),
    caps: defaultCaps(),
    ...partial,
  };
}

/**
 * A group with no members yet. Its box is a placeholder: the store's group normaliser sets it to its members' in the
 * commit that adds it (and deletes a group that has none).
 */
export function groupNodeDefaults(page: Page, partial: Partial<GroupNode>, existingIds: Iterable<string>): GroupNode {
  return {
    id: newId("p", existingIds),
    type: "group",
    page: page.id,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    z: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    ...partial,
  };
}
