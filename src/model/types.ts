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

export interface Stroke {
  color: string;
  width: number;
  dash: "solid" | "dash" | "dot" | "dashDot";
  opacity?: number;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round";
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
}

export type Range16 = { min: number; max: number };

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

/** M2 widens this union. */
export type Node = FileNode | TextNode;

export interface Document {
  version: 1;
  pages: Page[];
  nodes: Node[];
  edges: never[];
}
