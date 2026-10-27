// Writes the test-vault fixture files into the directory given as argv[2]:
//   plot.png   200x120 RGB, two coloured halves (`--alt` swaps the two colours)
//   plot.svg   200x120 SVG with a clipPath, a clipped rect and a text element
//   plot.pdf   two pages (page 1: three line segments and "Fig"; page 2: a filled rectangle)
//   cells.tif  3-plane 16-bit grayscale 256x256 TIFF
// Usage: node scripts/make-fixtures.mjs <dir> [--alt]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { jsPDF } from "jspdf";
import UTIF from "utif";

process.env.TZ = "UTC";

const args = process.argv.slice(2);
const alt = args.includes("--alt");
const outArg = args.find((a) => !a.startsWith("--"));
if (!outArg) {
  console.error("usage: node scripts/make-fixtures.mjs <dir> [--alt]");
  process.exit(1);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

// ---- PNG -------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function makePng(width, height, left, right) {
  const rowBytes = 1 + width * 3; // filter byte + RGB
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = x < width / 2 ? left : right;
      raw.set([r, g, b], y * rowBytes + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  // compression, filter and interlace methods stay 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const RED = [217, 79, 79];
const BLUE = [79, 111, 217];
writeFileSync(join(outDir, "plot.png"), makePng(200, 120, alt ? BLUE : RED, alt ? RED : BLUE));

// ---- SVG -------------------------------------------------------------------------------------

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
  <defs>
    <clipPath id="c1"><rect x="20" y="20" width="100" height="60"/></clipPath>
  </defs>
  <rect width="200" height="120" fill="#ffffff"/>
  <rect x="0" y="0" width="200" height="120" fill="#4f6fd9" clip-path="url(#c1)"/>
  <text x="10" y="110" font-family="Arial" font-size="14" fill="#000000">Fig</text>
</svg>
`;
writeFileSync(join(outDir, "plot.svg"), SVG);

// ---- PDF -------------------------------------------------------------------------------------

function makePdf() {
  const doc = new jsPDF({ unit: "pt", format: [200, 120], orientation: "landscape" });
  // Fixed metadata so regenerating the fixture is byte-for-byte reproducible (jsPDF writes the
  // date in local time, hence TZ is pinned at the top of this file; the file id must be 32 hex digits).
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setFileId("6c696e6b2d6669677572657300000000");
  doc.setLineWidth(1);
  doc.line(20, 90, 70, 30);
  doc.line(70, 30, 120, 70);
  doc.line(120, 70, 180, 20);
  doc.setFontSize(12);
  doc.text("Fig", 10, 112);
  doc.addPage([200, 120], "landscape");
  doc.setFillColor(217, 79, 79);
  doc.rect(30, 20, 140, 80, "F");
  return Buffer.from(doc.output("arraybuffer"));
}
writeFileSync(join(outDir, "plot.pdf"), makePdf());

// ---- TIFF ------------------------------------------------------------------------------------

// UTIF.encode only writes the header and the IFD tag tables (into a fixed 20 kB buffer) and always
// emits a big-endian ("MM") file; it never writes strip data. So: encode the IFDs once to learn
// the header length, point each IFD's strip at its plane after the header, encode again, then
// append the planes. Samples are big-endian to match the "MM" byte order.
function makeTiff(planes, width, height) {
  const planeBytes = width * height * 2;
  const ifd = (stripOffset) => ({
    t256: [width],
    t257: [height],
    t258: [16],
    t259: [1],
    t262: [1], // BlackIsZero
    t273: [stripOffset],
    t277: [1],
    t278: [height],
    t279: [planeBytes],
  });
  const headerLength = new Uint8Array(UTIF.encode(planes.map(() => ifd(0)))).length;
  const header = new Uint8Array(UTIF.encode(planes.map((_, i) => ifd(headerLength + i * planeBytes))));
  const out = Buffer.alloc(headerLength + planes.length * planeBytes);
  out.set(header, 0);
  planes.forEach((plane, i) => {
    for (let p = 0; p < plane.length; p++) out.writeUInt16BE(plane[p], headerLength + i * planeBytes + p * 2);
  });
  return out;
}

function makePlane(width, height, value) {
  const plane = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) plane[y * width + x] = value(x, y);
  return plane;
}

const SIZE = 256;
const MAX_RADIUS = (SIZE / 2) * Math.SQRT2; // centre (128,128) to the corner (0,0)
const planes = [
  // radial gradient: 4000 at the centre falling to 100 at the corner
  makePlane(SIZE, SIZE, (x, y) =>
    Math.round(4000 - 3900 * (Math.hypot(x - SIZE / 2, y - SIZE / 2) / MAX_RADIUS)),
  ),
  // constant
  makePlane(SIZE, SIZE, () => 50),
  // diagonal gradient: 0 at the top-left corner to 4000 at the bottom-right
  makePlane(SIZE, SIZE, (x, y) => Math.round(((x + y) / (2 * (SIZE - 1))) * 4000)),
];
writeFileSync(join(outDir, "cells.tif"), makeTiff(planes, SIZE, SIZE));

console.log(`fixtures written to ${outDir}${alt ? " (alt colours)" : ""}`);
