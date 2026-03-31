const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Generate a minimal PNG icon with a red play-button circle on dark background.
 */
function createPNG(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(2, 9);   // color type RGB
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Image data
  const rawData = Buffer.alloc(size * (size * 3 + 1));
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.42;
  const innerR = size * 0.36;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    rawData[rowStart] = 0; // filter: none

    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= outerR) {
        // Red circle
        rawData[px] = 255;     // R
        rawData[px + 1] = 0;   // G
        rawData[px + 2] = 0;   // B

        // White play triangle inside
        if (dist <= innerR) {
          const nx = (x - cx) / innerR;
          const ny = (y - cy) / innerR;
          // Triangle: left vertex (-0.3, -0.4), (-0.3, 0.4), (0.5, 0)
          if (nx >= -0.3 && nx <= 0.5) {
            const maxY = 0.4 * (0.5 - nx) / 0.8;
            if (Math.abs(ny) <= maxY) {
              rawData[px] = 255;
              rawData[px + 1] = 255;
              rawData[px + 2] = 255;
            }
          }
        }
      } else {
        // Dark background
        rawData[px] = 15;
        rawData[px + 1] = 15;
        rawData[px + 2] = 15;
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcBuf]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Generate icons
const iconsDir = path.join(__dirname, '..', 'assets', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

for (const size of [16, 32, 48, 128]) {
  const png = createPNG(size);
  fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), png);
  console.log(`Generated icon-${size}.png (${png.length} bytes)`);
}

console.log('Done!');
