import { DEFAULT_FONT, MM_TO_PX } from "../constants";
import { mmToPx } from "./geometry";
import { getPreset } from "./presets";
import type { Document, FileNode, Page, TextNode } from "./types";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 4;

/** `p` for nodes, `pg` for pages: `<prefix>-<4 chars of [a-z0-9]>`, not already in `existing`. */
export function newId(prefix: "p" | "pg", existing: Iterable<string>): string {
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
