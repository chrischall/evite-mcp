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

  it('returns 0/0 for a too-short PNG buffer', () => {
    expect(imageDimensions(Buffer.alloc(10), 'image/png')).toEqual({ width: 0, height: 0 });
  });

  it('returns 0/0 for a PNG whose IHDR chunk is missing', () => {
    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('NOPE'), // not "IHDR"
      Buffer.from([0, 0, 0, 3, 0, 0, 0, 2]),
    ]);
    expect(imageDimensions(buf, 'image/png')).toEqual({ width: 0, height: 0 });
  });

  it('returns 0/0 for a JPEG without the SOI marker', () => {
    expect(imageDimensions(Buffer.from([0x00, 0x11, 0x22, 0x33]), 'image/jpeg')).toEqual({ width: 0, height: 0 });
  });

  it('skips a stray non-0xFF byte while scanning for the next JPEG marker', () => {
    // After SOI, a 0x00 fill byte precedes the real FFC0 SOF marker.
    const buf = Buffer.from([
      0xff, 0xd8, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x04,
    ]);
    expect(imageDimensions(buf, 'image/jpeg')).toEqual({ width: 4, height: 5 });
  });

  it('skips standalone JPEG markers and the non-SOF segment markers (DHT/JPG/DAC)', () => {
    const buf = Buffer.from([
      0xff, 0xd8,
      0xff, 0xd0, // RST0 — standalone, no length
      0xff, 0xc4, 0x00, 0x04, 0x11, 0x22, // DHT segment (C4, not a SOF), len 4
      0xff, 0xc8, 0x00, 0x04, 0x33, 0x44, // JPG  (C8)
      0xff, 0xcc, 0x00, 0x04, 0x55, 0x66, // DAC  (CC)
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, // SOF0 → 640x400
    ]);
    expect(imageDimensions(buf, 'image/jpeg')).toEqual({ width: 640, height: 400 });
  });

  it('stops on a malformed JPEG segment length (< 2) and returns 0/0', () => {
    const buf = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, // APP0 with segLen=1 (< 2)
    ]);
    expect(imageDimensions(buf, 'image/jpeg')).toEqual({ width: 0, height: 0 });
  });

  it('returns 0/0 for a valid JPEG that never reaches a SOF marker', () => {
    const buf = Buffer.from([
      0xff, 0xd8,
      0xff, 0xd9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // EOI then padding, no SOF
    ]);
    expect(imageDimensions(buf, 'image/jpeg')).toEqual({ width: 0, height: 0 });
  });
});
