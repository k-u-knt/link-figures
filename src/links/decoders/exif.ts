/** The EXIF Orientation tag. */
const ORIENTATION_TAG = 0x0112;

/**
 * A JPEG's EXIF orientation (1-8), read from the first APP1 "Exif" segment's IFD0, or 1 when the bytes are not a JPEG,
 * have no EXIF orientation, or it is malformed or out of range. 1 is upright; any other value means a viewer that
 * honours EXIF (the browser, so the stage) draws the stored pixels turned or mirrored.
 */
export function jpegOrientation(input: ArrayBuffer | Uint8Array): number {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 1;
    const marker = bytes[at + 1];
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Start of scan or end of image: no more metadata segments.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = view.getUint16(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return 1;
    if (marker === 0xe1) {
      const found = exifOrientation(view, at + 4, length - 2);
      if (found !== undefined) return found;
    }
    at += 2 + length;
  }
  return 1;
}

/** The orientation in an APP1 segment's body at `start`, or undefined when the segment is not EXIF or has none. */
function exifOrientation(view: DataView, start: number, size: number): number | undefined {
  // "Exif\0\0"
  if (size < 14 || view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return undefined;
  const tiff = start + 6;
  const end = start + size;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const le = order === 0x4949;
  if (view.getUint16(tiff + 2, le) !== 42) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, le);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, le) !== ORIENTATION_TAG) continue;
    // Type 3 (SHORT), count 1: the value sits in the first two bytes of the value field.
    if (view.getUint16(entry + 2, le) !== 3) return 1;
    const value = view.getUint16(entry + 8, le);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}
