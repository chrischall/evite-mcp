import { describe, it, expect } from 'vitest';
import { mimetypeForPath, imageDimensions } from '../src/image-meta.js';

describe('mimetypeForPath', () => {
  it('maps common image extensions (case-insensitive)', () => {
    expect(mimetypeForPath('/a/b/photo.jpg')).toBe('image/jpeg');
    expect(mimetypeForPath('photo.JPEG')).toBe('image/jpeg');
    expect(mimetypeForPath('x.png')).toBe('image/png');
    expect(mimetypeForPath('x.gif')).toBe('image/gif');
    expect(mimetypeForPath('x.webp')).toBe('image/webp');
    expect(mimetypeForPath('x.heic')).toBe('image/heic');
  });
  it('returns undefined for non-image / unknown extensions', () => {
    expect(mimetypeForPath('notes.txt')).toBeUndefined();
    expect(mimetypeForPath('noext')).toBeUndefined();
  });
});

describe('imageDimensions', () => {
  it('reads PNG width/height from the IHDR chunk', () => {
    // 8-byte PNG signature, then IHDR length+type, then width=3 height=2 (BE).
    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), // IHDR length
      Buffer.from('IHDR'),
      Buffer.from([0, 0, 0, 3, 0, 0, 0, 2]), // width=3, height=2
    ]);
    expect(imageDimensions(buf, 'image/png')).toEqual({ width: 3, height: 2 });
  });

  it('reads JPEG width/height from the SOF marker', () => {
    // FFD8 (SOI), then a SOF0 (FFC0) segment: len, precision, height=5, width=4.
    const buf = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x04,
    ]);
    expect(imageDimensions(buf, 'image/jpeg')).toEqual({ width: 4, height: 5 });
  });

  it('skips JPEG segments before the SOF', () => {
    const buf = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x01, 0x02, // APP0 segment, length 4 → skip 2 payload bytes
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, // SOF0 height=0x190=400 width=0x280=640
    ]);
    expect(imageDimensions(buf, 'image/jpeg')).toEqual({ width: 640, height: 400 });
  });

  it('returns 0/0 for formats it cannot parse', () => {
    expect(imageDimensions(Buffer.from([1, 2, 3]), 'image/heic')).toEqual({ width: 0, height: 0 });
  });
});
