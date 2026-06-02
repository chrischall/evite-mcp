// ────────────────────────────────────────────────────────────────────────────
// Image metadata — mimetype (from extension) + pixel dimensions (header parse).
//
// Evite's photo-upload "request" step (POST …/upload/request/) wants the
// `mimetype`, `width`, and `height` of the image. The GCS signed-POST policy it
// returns enforces `Content-Type == mimetype`, so the value sent here MUST match
// the Blob's type on the upload. Dimensions are metadata only (not policy-bound),
// so a 0/0 fallback for formats we don't parse is acceptable.
// ────────────────────────────────────────────────────────────────────────────

/** Map a file extension to an image mimetype, or `undefined` if not an image. */
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heic',
};

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
