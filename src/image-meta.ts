// ────────────────────────────────────────────────────────────────────────────
// Image metadata — mimetype (from extension) + pixel dimensions (header parse).
//
// Evite's photo-upload "request" step (POST …/upload/request/) wants the
// `mimetype`, `width`, and `height` of the image. The GCS signed-POST policy it
// returns enforces `Content-Type == mimetype`, so the value sent here MUST match
// the Blob's type on the upload. Dimensions are metadata only (not policy-bound),
// so a 0/0 fallback for formats we don't parse is acceptable.
// ────────────────────────────────────────────────────────────────────────────

/** The 8-byte PNG file signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Map a file extension to an image mimetype, or `undefined` if not an image. */
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

/** Every image mimetype the upload accepts (each listed once). */
export const IMAGE_MIMETYPES = [...new Set(Object.values(EXT_MIME))] as [string, ...string[]];

/** ISO-BMFF `ftyp` brands that mark a HEIC (HEVC-coded) or generic HEIF image. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/**
 * Identify an image from its leading bytes (magic numbers), independent of the
 * file name or any declared type. Returns `undefined` for anything that is not
 * one of the supported image formats — an SSH key, a JSON session file, a
 * `.env` — so a caller can refuse to upload non-image bytes whatever the
 * extension or mimetype claims.
 */
export function sniffImageMime(buf: Buffer): string | undefined {
  const ascii = (start: number, end: number): string => buf.toString('latin1', start, end);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }
  return undefined;
}

/**
 * Whether two image mimetypes name the same format. HEIC is a HEIF profile, and
 * Apple devices label the same file either way, so the two are one family.
 */
export function sameImageType(a: string, b: string): boolean {
  const family = (m: string): string => (m === 'image/heif' ? 'image/heic' : m);
  return family(a) === family(b);
}

/** Infer the image mimetype from a path's extension (case-insensitive). */
export function mimetypeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_MIME[path.slice(dot + 1).toLowerCase()];
}

/** Pixel dimensions of an image. `{0,0}` when the format isn't parseable here. */
export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Best-effort image dimensions from the file header. Parses PNG (IHDR) and JPEG
 * (SOF marker) — the dominant photo formats. Anything else returns `{0,0}`
 * (dimensions are not enforced by the upload policy, so this is a safe default).
 */
export function imageDimensions(buf: Buffer, mimetype: string): Dimensions {
  if (mimetype === 'image/png') return pngDimensions(buf);
  if (mimetype === 'image/jpeg') return jpegDimensions(buf);
  return { width: 0, height: 0 };
}

function pngDimensions(buf: Buffer): Dimensions {
  // 8-byte signature, 4-byte chunk length, "IHDR", then width/height (BE uint32).
  if (buf.length < 24) return { width: 0, height: 0 };
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): Dimensions {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { width: 0, height: 0 };
  let i = 2;
  // Need indices up to i+8 readable for the SOF height/width (readUInt16BE(i+7)).
  while (i + 9 <= buf.length) {
    // Markers are 0xFF followed by a non-0xFF, non-zero byte.
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    // SOF0..SOF15 (0xC0–0xCF) carry the frame size, EXCEPT the non-SOF markers
    // DHT(C4), JPG(C8), DAC(CC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // After FF Cn: 2-byte length, 1-byte precision, 2-byte height, 2-byte width.
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    // Standalone markers (no length): SOI/EOI/RSTn/TEM.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    // Otherwise a segment with a 2-byte length following the marker.
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  return { width: 0, height: 0 };
}
