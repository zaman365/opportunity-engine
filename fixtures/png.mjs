import { deflateSync } from 'node:zlib';

/**
 * A minimal PNG encoder for the M2 fixtures.
 *
 * The alternative was committing binary image files, which would make it impossible to see at
 * review time what a fixture actually serves. Generating them keeps every fixture byte
 * explainable from source, and lets a route serve a deliberately truncated or zero-length
 * image without shipping a corrupt file.
 *
 * Truecolour, 8 bits per channel, no interlacing. Nothing here is a general-purpose encoder.
 */

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * A vertical two-colour gradient with a darker band across the middle, so a rendered fixture
 * image is obviously an image and two different fixtures are obviously different.
 */
export function gradientPng(width, height, top, bottom) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type: none
    const t = height === 1 ? 0 : y / (height - 1);
    const band = Math.abs(t - 0.5) < 0.04 ? 0.55 : 1;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = top[channel] + (bottom[channel] - top[channel]) * t;
        raw[offset + channel] = Math.round(Math.max(0, Math.min(255, value * band)));
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
