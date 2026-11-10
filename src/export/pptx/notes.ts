import { CLR_MAP, DECL, escapeXml, listStyle, NS_PML, TREE_HEAD } from "./xml";

/** The notes body placeholder's non-visual properties: the one placeholder notes pages have here. */
const BODY_NV =
  '<p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>';

/** Characters XML 1.0 cannot hold at all, even as references. */
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** One `a:p` per line of `text`; an empty line is an empty paragraph, so a paragraph break shows as a gap. */
function paragraphs(text: string): string {
  return text
    .replace(NOT_XML, "")
    .split(/\r\n?|\n/)
    .map((line) => (line === "" ? '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>' : `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`))
    .join("");
}

/**
 * The notes master (`ppt/notesMasters/notesMaster1.xml`): a minimal one, with a white background, a single body
 * placeholder on the lower half of a portrait notes page (`notesSz` 6858000 × 9144000) and a 12 pt notes style. Its
 * theme is its own part (`theme2.xml`), as PowerPoint writes it.
 */
export function notesMasterXml(): string {
  const body =
    `<p:sp>${BODY_NV}<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
  return (
    `${DECL}<p:notesMaster ${NS_PML}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
    `<p:spTree>${TREE_HEAD}${body}</p:spTree></p:cSld>${CLR_MAP}<p:notesStyle>${listStyle("+mn-lt", 1200)}</p:notesStyle></p:notesMaster>`
  );
}

/** A notes slide (`ppt/notesSlides/notesSlideN.xml`) holding `text` in its body placeholder, one paragraph per line. */
export function notesSlideXml(text: string): string {
  const body = `<p:sp>${BODY_NV}<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs(text)}</p:txBody></p:sp>`;
  return `${DECL}<p:notes ${NS_PML}><p:cSld><p:spTree>${TREE_HEAD}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}
