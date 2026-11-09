export type NodeId = string;
export type PageId = string;

/** Page margins in mm. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Page {
  id: PageId;
  name: string;
  preset?: string;
  width: number;
  height: number;
  paper: string;
  margins: Margins;
  grid: { spacing: number; show: boolean };
}

/** Crop region, normalised 0-1 of the natural size. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A registered paint type's id plus its params (see `PaintType`); one this plugin does not know is kept as it is. */
export type Paint = { type: string } & Record<string, unknown>;

/** One colour of a gradient, at `offset` (0-1) along it. */
export type Stop = { offset: number; color: string; opacity?: number };

/** A line, painted like a fill: a frame, a shape's border, a connector. `width` is in pt. */
export interface Stroke {
  paint: Paint;
  width: number;
  dash: "solid" | "dash" | "dot" | "dashDot";
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
}

export interface NodeBase {
  id: NodeId;
  type: string;
  page: PageId;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  rotation: number;
  opacity: number;
  locked: boolean;
  name?: string;
  color?: string;
  /**
   * The group (any node whose type has a `members` hook) this node is a member of, absent at top level. A member is on
   * its group's page. Set by the group commands only; the group normaliser removes one that names no such node.
   */
  parent?: NodeId;
}

export type Range16 = { min: number; max: number };

/** One non-destructive step applied to a panel's image; `type` is a registered adjustment id (an unknown one is kept as is). */
export interface Adjustment {
  type: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface FileNode extends NodeBase {
  type: "file";
  file: string;
  subpath: string;
  show: "image" | "content";
  imageIndex: number;
  crop: Crop | null;
  fit: "cover" | "contain";
  pageIndex: number;
  range: Range16 | "auto";
  scale: number;
  frame: Stroke | null;
  adjustments: Adjustment[];
}

export interface Font {
  family: string;
  /** Size in pt. */
  size: number;
  weight: "normal" | "bold";
  italic: boolean;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
}

export interface TextNode extends NodeBase {
  type: "text";
  text: string;
  font: Font;
}

/**
 * A drawn shape: `kind` is a registered shape kind's id (an unknown one is kept as it is) and `params` that kind's own
 * attributes (a rectangle's `cornerRadius`, in px). `fill` paints the inside (`{ type: "none" }` for none) and `border`
 * the edge (null for none).
 */
export interface ShapeNode extends NodeBase {
  type: "shape";
  kind: string;
  params: Record<string, unknown>;
  fill: Paint;
  border: Stroke | null;
}

/**
 * One end of a connector: a free point in page px, or attached to an item (any node whose type is `attachable`) at one of
 * its anchors or at its centre. An attached end stores no point of its own; it is resolved from the item at render time.
 */
export type End =
  | { kind: "free"; x: number; y: number }
  | { kind: "attached"; node: NodeId; snap: "anchor"; anchor: string }
  | { kind: "attached"; node: NodeId; snap: "center" };

/** What a connector draws at one end: `kind` is a registered cap kind's id (an unknown one is kept as it is), `size` a multiple of the stroke's width. */
export type Cap = { kind: string; size: number };

/**
 * A line between two ends: `route` is a registered route's id (an unknown one is kept as it is) and `routeParams` that
 * route's own attributes. `caps` are drawn at the start and the end. The box (`x, y, width, height`) holds the bounds of
 * what is drawn; a connector is never rotated.
 */
export interface ConnectorNode extends NodeBase {
  type: "connector";
  ends: [End, End];
  route: string;
  routeParams: Record<string, unknown>;
  stroke: Stroke;
  caps: [Cap, Cap];
}

/**
 * A group of nodes: the nodes whose `parent` is its id. It has no fields of its own; its box is the union of its members'
 * boxes and its `z` the highest member's, both kept by the store's group normaliser, and it is never rotated or translucent.
 */
export interface GroupNode extends NodeBase {
  type: "group";
}

export type Node = FileNode | TextNode | ShapeNode | ConnectorNode | GroupNode;

export interface Document {
  version: 1;
  pages: Page[];
  nodes: Node[];
  edges: never[];
}
