import type { Pt, Rect } from "../../model/geometry";
import { nvPrXml, turnedXfrmXml } from "./drawingml";
import type { PptxContext } from "../../registry/node-type";

/** A data URI's MIME type and bytes; null for one that is not base64 or URL-encoded data. */
export function dataUriBytes(uri: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = (m[1] || "text/plain").toLowerCase();
  try {
    if (m[3]) {
      const binary = atob(m[4]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { mime, bytes };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[4])) };
  } catch {
    return null;
  }
}

/** The media extension PowerPoint takes for a MIME type, or null for one it is not given as is. */
export function mediaExt(mime: string): "png" | "jpeg" | null {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpeg";
  return null;
}

/** The sides of a picture cut off, as fractions of the image (each ≥ 0): `a:srcRect`'s l, t, r, b. */
export interface SrcRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface PictureSpec {
  id: number;
  name: string;
  descr?: string;
  /** The relationship id of its media (`PptxContext.addMedia`). */
  rId: string;
  /** Where it shows, page px, before the turn. */
  rect: Rect;
  /** What it turns about, and by how much (degrees clockwise): its node's centre and rotation. */
  pivot: Pt;
  rotation: number;
  srcRect?: SrcRect;
  /** 0-1: the node's opacity. */
  alpha: number;
  /** An `a:ln` for the picture's edge, or none. */
  ln?: string;
}

const per100k = (v: number): number => Math.round(Math.max(0, v) * 100000);

/** A `p:pic`: the media stretched over its rect, cut by `srcRect` (1/1000 per cent per side), faded by `alpha`. */
export function pictureXml(spec: PictureSpec, ctx: Pick<PptxContext, "px">): string {
  const alpha = spec.alpha < 1 ? `<a:alphaModFix amt="${per100k(spec.alpha)}"/>` : "";
  const s = spec.srcRect;
  const src = s && (s.l > 0 || s.t > 0 || s.r > 0 || s.b > 0) ? `<a:srcRect l="${per100k(s.l)}" t="${per100k(s.t)}" r="${per100k(s.r)}" b="${per100k(s.b)}"/>` : "";
  return (
    `<p:pic><p:nvPicPr>${nvPrXml(spec.id, spec.name, spec.descr)}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${spec.rId}">${alpha}</a:blip>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${turnedXfrmXml(spec.rect, spec.pivot, spec.rotation, ctx)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spec.ln ?? ""}</p:spPr></p:pic>`
  );
}
