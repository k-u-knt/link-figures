import { zip, type ZipInput } from "../zip";
import { notesMasterXml, notesSlideXml } from "./notes";
import { CLR_MAP, DECL, escapeXml, listStyle, NS_A, NS_PML, PML_CT, relsXml, rt, TREE_HEAD, type Rel } from "./xml";

export { escapeXml };

/** A file a slide shows (a picture's PNG or JPEG): its name in `ppt/media/` (made unique if taken) and its MIME type. */
export interface PptxMedia {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * One slide: `xml` is what goes in its shape tree after the tree's own properties (the `p:sp`, `p:pic`… elements),
 * `background` a `#rrggbb` colour (none: the master's, white). Media `i` is the slide's relationship `slideMediaRId(i)`.
 */
export interface PptxSlideInput {
  xml: string;
  background?: string;
  media: PptxMedia[];
  /** The slide's presenter notes, plain text with one paragraph per line; none (or empty) writes no notes slide. */
  notes?: string;
}

export interface PptxPackageInput {
  /** The slide size in EMU, whole numbers within what PowerPoint opens (1-56 inches a side). */
  sizeEmu: { cx: number; cy: number };
  slides: PptxSlideInput[];
  title?: string;
  /** When the file was made; now when not given. */
  created?: Date;
}

/** PowerPoint's limits on a slide's sides: 1 inch to 56 inches, in EMU. */
export const MIN_SLIDE_EMU = 914400;
export const MAX_SLIDE_EMU = 51206400;

/** The relationship id of a slide's media `index` (its layout is `rId1`). */
export const slideMediaRId = (index: number): string => `rId${index + 2}`;

const CORE_PROPERTIES_REL = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

// `r:id` is written before `id` on the id-list items: happy-dom, which the tests parse with, drops a prefixed attribute
// whose local name an earlier attribute has.

const MASTER_ID = 2147483648;
const LAYOUT_ID = 2147483649;
const FIRST_SLIDE_ID = 256;

const MASTER =
  `${DECL}<p:sldMaster ${NS_PML}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${TREE_HEAD}</p:spTree></p:cSld>${CLR_MAP}` +
  `<p:sldLayoutIdLst><p:sldLayoutId r:id="rId1" id="${LAYOUT_ID}"/></p:sldLayoutIdLst>` +
  `<p:txStyles><p:titleStyle>${listStyle("+mj-lt", 4400)}</p:titleStyle><p:bodyStyle>${listStyle("+mn-lt", 2800)}</p:bodyStyle>` +
  `<p:otherStyle>${listStyle("+mn-lt", 1800)}</p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT =
  `${DECL}<p:sldLayout ${NS_PML} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${TREE_HEAD}</p:spTree></p:cSld>` +
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

const sysClr = (name: string, val: string, last: string): string => `<a:${name}><a:sysClr val="${val}" lastClr="${last}"/></a:${name}>`;
const srgb = (name: string, val: string): string => `<a:${name}><a:srgbClr val="${val}"/></a:${name}>`;
const font = (latin: string): string => `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/>`;
const phFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const ln = (w: number): string => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${phFill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;

/** A whole minimal theme: the Office colours and fonts, and three of each fill, line, effect and background style. */
const THEME =
  `${DECL}<a:theme xmlns:a="${NS_A}" name="Link Figures"><a:themeElements>` +
  '<a:clrScheme name="Office">' +
  sysClr("dk1", "windowText", "000000") +
  sysClr("lt1", "window", "FFFFFF") +
  srgb("dk2", "44546A") +
  srgb("lt2", "E7E6E6") +
  srgb("accent1", "4472C4") +
  srgb("accent2", "ED7D31") +
  srgb("accent3", "A5A5A5") +
  srgb("accent4", "FFC000") +
  srgb("accent5", "5B9BD5") +
  srgb("accent6", "70AD47") +
  srgb("hlink", "0563C1") +
  srgb("folHlink", "954F72") +
  "</a:clrScheme>" +
  `<a:fontScheme name="Office"><a:majorFont>${font("Calibri Light")}</a:majorFont><a:minorFont>${font("Calibri")}</a:minorFont></a:fontScheme>` +
  '<a:fmtScheme name="Office"><a:fillStyleLst>' +
  phFill +
  phFill +
  phFill +
  `</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>` +
  "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
  `<a:bgFillStyleLst>${phFill}${phFill}${phFill}</a:bgFillStyleLst></a:fmtScheme>` +
  "</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>";

const PRES_PROPS = `${DECL}<p:presentationPr ${NS_PML}/>`;
const VIEW_PROPS = `${DECL}<p:viewPr ${NS_PML}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`;
const TABLE_STYLES = `${DECL}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

const COLOR = /^#([0-9a-fA-F]{6})$/;

function slideXml(slide: PptxSlideInput): string {
  let bg = "";
  if (slide.background !== undefined) {
    const m = COLOR.exec(slide.background);
    if (!m) throw new Error(`pptx: the background "${slide.background}" is not a #rrggbb colour`);
    bg = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${m[1].toUpperCase()}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
  }
  return `${DECL}<p:sld ${NS_PML}><p:cSld>${bg}<p:spTree>${TREE_HEAD}${slide.xml}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** `date` as W3CDTF without milliseconds. */
const w3cdtf = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * A PresentationML package (`.pptx` bytes) of `input`: the package and document properties, one presentation with one
 * master, one blank layout and one theme, one slide per `input.slides` with its relationships (`rId1` its layout, then
 * its media), and the media in `ppt/media/` (stored, not deflated). A slide with `notes` gets a notes slide, and the
 * package then has a notes master with its own theme; without notes, none of these parts are written. Throws on no
 * slides, a slide size PowerPoint does not open, or a background that is not a colour.
 */
export function buildPptx(input: PptxPackageInput): Uint8Array {
  const { cx, cy } = input.sizeEmu;
  for (const side of [cx, cy])
    if (!Number.isInteger(side) || side < MIN_SLIDE_EMU || side > MAX_SLIDE_EMU) throw new Error(`pptx: the slide size ${cx}×${cy} EMU is not one PowerPoint opens`);
  if (input.slides.length === 0) throw new Error("pptx: no slides");

  const encoder = new TextEncoder();
  const parts: ZipInput[] = [];
  const xml = (name: string, text: string): void => {
    parts.push({ name, data: encoder.encode(text) });
  };

  const overrides: [string, string][] = [
    ["/ppt/presentation.xml", `${PML_CT}.presentation.main+xml`],
    ["/ppt/presProps.xml", `${PML_CT}.presProps+xml`],
    ["/ppt/viewProps.xml", `${PML_CT}.viewProps+xml`],
    ["/ppt/tableStyles.xml", `${PML_CT}.tableStyles+xml`],
    ["/ppt/slideMasters/slideMaster1.xml", `${PML_CT}.slideMaster+xml`],
    ["/ppt/slideLayouts/slideLayout1.xml", `${PML_CT}.slideLayout+xml`],
    ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
    ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
    ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
  ];
  const defaults = new Map<string, string>([
    ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
    ["xml", "application/xml"],
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
  ]);

  // Notes parts only when some slide has notes, so a package without them is as it always was.
  const hasNotes = input.slides.some((slide) => slide.notes !== undefined && slide.notes !== "");
  if (hasNotes) {
    overrides.push(
      ["/ppt/notesMasters/notesMaster1.xml", `${PML_CT}.notesMaster+xml`],
      ["/ppt/theme/theme2.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
    );
  }

  // Slides, their rels, their notes and their media (named uniquely across the package).
  const usedMedia = new Set<string>();
  const media: ZipInput[] = [];
  const slideParts: ZipInput[] = [];
  input.slides.forEach((slide, i) => {
    const n = i + 1;
    overrides.push([`/ppt/slides/slide${n}.xml`, `${PML_CT}.slide+xml`]);
    const rels: Rel[] = [{ id: "rId1", type: rt("slideLayout"), target: "../slideLayouts/slideLayout1.xml" }];
    slide.media.forEach((m, j) => {
      const dot = m.name.lastIndexOf(".");
      const stem = dot > 0 ? m.name.slice(0, dot) : m.name;
      const ext = dot > 0 ? m.name.slice(dot + 1).toLowerCase() : "bin";
      let name = `${stem}.${ext}`;
      for (let k = 2; usedMedia.has(name); k++) name = `${stem}-${k}.${ext}`;
      usedMedia.add(name);
      if (!defaults.has(ext)) defaults.set(ext, m.contentType);
      else if (defaults.get(ext) !== m.contentType) overrides.push([`/ppt/media/${name}`, m.contentType]);
      media.push({ name: `ppt/media/${name}`, data: m.bytes, store: true });
      rels.push({ id: slideMediaRId(j), type: rt("image"), target: `../media/${name}` });
    });
    if (slide.notes !== undefined && slide.notes !== "") {
      // After the slide's media: its rIds are `slideMediaRId`'s.
      rels.push({ id: `rId${slide.media.length + 2}`, type: rt("notesSlide"), target: `../notesSlides/notesSlide${n}.xml` });
      overrides.push([`/ppt/notesSlides/notesSlide${n}.xml`, `${PML_CT}.notesSlide+xml`]);
      slideParts.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: encoder.encode(notesSlideXml(slide.notes)) });
      slideParts.push({
        name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        data: encoder.encode(
          relsXml([
            { id: "rId1", type: rt("notesMaster"), target: "../notesMasters/notesMaster1.xml" },
            { id: "rId2", type: rt("slide"), target: `../slides/slide${n}.xml` },
          ]),
        ),
      });
    }
    slideParts.push({ name: `ppt/slides/slide${n}.xml`, data: encoder.encode(slideXml(slide)) });
    slideParts.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: encoder.encode(relsXml(rels)) });
  });

  const defaultItems = [...defaults].map(([ext, type]) => `<Default Extension="${escapeXml(ext)}" ContentType="${escapeXml(type)}"/>`).join("");
  const overrideItems = overrides.map(([part, type]) => `<Override PartName="${escapeXml(part)}" ContentType="${escapeXml(type)}"/>`).join("");
  xml("[Content_Types].xml", `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaultItems}${overrideItems}</Types>`);

  xml(
    "_rels/.rels",
    relsXml([
      { id: "rId1", type: rt("officeDocument"), target: "ppt/presentation.xml" },
      { id: "rId2", type: CORE_PROPERTIES_REL, target: "docProps/core.xml" },
      { id: "rId3", type: rt("extended-properties"), target: "docProps/app.xml" },
    ]),
  );

  const created = w3cdtf(input.created ?? new Date());
  const title = input.title === undefined ? "" : `<dc:title>${escapeXml(input.title)}</dc:title>`;
  xml(
    "docProps/core.xml",
    `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
      'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `${title}<dc:creator>Link Figures</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`,
  );
  xml(
    "docProps/app.xml",
    `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
      `<Application>Link Figures</Application><PresentationFormat>Custom</PresentationFormat><Slides>${input.slides.length}</Slides></Properties>`,
  );

  // Presentation rels: the master, the slides, then the theme and the properties parts.
  const presRels: Rel[] = [{ id: "rId1", type: rt("slideMaster"), target: "slideMasters/slideMaster1.xml" }];
  const slideIds = input.slides.map((_, i) => {
    const id = `rId${i + 2}`;
    presRels.push({ id, type: rt("slide"), target: `slides/slide${i + 1}.xml` });
    return `<p:sldId r:id="${id}" id="${FIRST_SLIDE_ID + i}"/>`;
  });
  const next = input.slides.length + 2;
  presRels.push(
    { id: `rId${next}`, type: rt("theme"), target: "theme/theme1.xml" },
    { id: `rId${next + 1}`, type: rt("presProps"), target: "presProps.xml" },
    { id: `rId${next + 2}`, type: rt("viewProps"), target: "viewProps.xml" },
    { id: `rId${next + 3}`, type: rt("tableStyles"), target: "tableStyles.xml" },
  );
  const notesMasterRId = `rId${next + 4}`;
  if (hasNotes) presRels.push({ id: notesMasterRId, type: rt("notesMaster"), target: "notesMasters/notesMaster1.xml" });
  const notesMasterList = hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRId}"/></p:notesMasterIdLst>` : "";
  xml(
    "ppt/presentation.xml",
    `${DECL}<p:presentation ${NS_PML} saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId r:id="rId1" id="${MASTER_ID}"/></p:sldMasterIdLst>${notesMasterList}` +
      `<p:sldIdLst>${slideIds.join("")}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `<p:defaultTextStyle>${listStyle("+mn-lt", 1800)}</p:defaultTextStyle></p:presentation>`,
  );
  xml("ppt/_rels/presentation.xml.rels", relsXml(presRels));
  xml("ppt/presProps.xml", PRES_PROPS);
  xml("ppt/viewProps.xml", VIEW_PROPS);
  xml("ppt/tableStyles.xml", TABLE_STYLES);
  xml("ppt/slideMasters/slideMaster1.xml", MASTER);
  xml(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    relsXml([
      { id: "rId1", type: rt("slideLayout"), target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: rt("theme"), target: "../theme/theme1.xml" },
    ]),
  );
  xml("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  xml("ppt/slideLayouts/_rels/slideLayout1.xml.rels", relsXml([{ id: "rId1", type: rt("slideMaster"), target: "../slideMasters/slideMaster1.xml" }]));
  xml("ppt/theme/theme1.xml", THEME);
  if (hasNotes) {
    xml("ppt/notesMasters/notesMaster1.xml", notesMasterXml());
    xml("ppt/notesMasters/_rels/notesMaster1.xml.rels", relsXml([{ id: "rId1", type: rt("theme"), target: "../theme/theme2.xml" }]));
    xml("ppt/theme/theme2.xml", THEME);
  }

  return zip([...parts, ...slideParts, ...media]);
}
