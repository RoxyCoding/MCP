import { deflateSync, crc32 } from 'node:zlib';

export function png(width, height) {
  function chunk(type, data) {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const header = Buffer.alloc(4), crc = Buffer.alloc(4);
    header.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload));
    return Buffer.concat([header, payload, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
