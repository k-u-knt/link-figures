/** What the PresentationML parts share: the declaration, the namespaces, escaping, relationships and a few fragments. */

export const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** The `a`, `r` and `p` prefixes, bound as a PresentationML part's root element binds them. */
export const NS_PML = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** The start of every PresentationML part's content type. */
export const PML_CT = "application/vnd.openxmlformats-officedocument.presentationml";

/** `s` escaped for XML text and attribute values (tabs and line breaks as character references, so an attribute keeps them). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface Rel {
  id: string;
  /** The relationship type's full URI. */
  type: string;
  target: string;
}

/** An officeDocument relationship type's URI (`slide`, `image`…). */
export const rt = (name: string): string => `${REL}/${name}`;

export function relsXml(rels: Rel[]): string {
  const items = rels.map((r) => `<Relationship Id="${r.id}" Type="${escapeXml(r.type)}" Target="${escapeXml(r.target)}"/>`).join("");
  return `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
}

/** The group properties every shape tree starts with (id 1 is the tree's; a slide's shapes take ids from 2). */
export const TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** A text style list with one level: `latin` the theme font (`+mj-lt`, `+mn-lt`), `sz` in 1/100 pt. */
export const listStyle = (latin: string, sz: number): string =>
  `<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="${sz}" kern="1200">` +
  `<a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${latin}"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>`;

/** The colour map a master gives its parts: the theme's light background and dark text. */
export const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
