import {inflateRawSync} from 'node:zlib';
import {safeObligationPath} from './obligations.mjs';

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// No filesystem extraction: only validated regular files become observable.
// ZIP64, multi-disk, encryption and non-UTF8 names are deliberately unsupported.
export function readCustodyZip(input, {maxBytes, maxFiles}) {
  const b = Buffer.from(input), files = new Map(), ranges = [];
  const reject = () => { throw Error('archive'); };
  const u16 = n => b.readUInt16LE(n), u32 = n => b.readUInt32LE(n);
  if (b.length < 22 || b.length > maxBytes) reject();
  let end = b.length - 22;
  while (end >= Math.max(0, b.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== b.length
      || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) reject();
  const count = u16(end + 10), start = u32(end + 16);
  if (!count || count > maxFiles || start + u32(end + 12) !== end) reject();
  let p = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || u32(p) !== 0x02014b50) reject();
    const flags = u16(p + 8), method = u16(p + 10), crc = u32(p + 16);
    const compressed = u32(p + 20), size = u32(p + 24), n = u16(p + 28);
    const extra = u16(p + 30), comment = u16(p + 32), offset = u32(p + 42);
    const nameBytes = b.subarray(p + 46, p + 46 + n), name = nameBytes.toString('utf8');
    const mode = u32(p + 38) >>> 16;
    if (p + 46 + n + extra + comment > end || !Buffer.from(name).equals(nameBytes)
        || !safeObligationPath(name) || files.has(name) || (flags & ~0x808)
        || ![0, 8].includes(method) || u16(p + 34) || (mode & 0xf000) && (mode & 0xf000) !== 0x8000
        || (u32(p + 38) & 0x10) || size > maxBytes || (total += size) > maxBytes) reject();
    if (offset + 30 > start || u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags
        || u16(offset + 8) !== method || u16(offset + 26) !== n
        || !b.subarray(offset + 30, offset + 30 + n).equals(nameBytes)) reject();
    const data = offset + 30 + n + u16(offset + 28), finish = data + compressed;
    let localEnd = finish;
    if (flags & 8) {
      const d = finish + (finish + 4 <= start && u32(finish) === 0x08074b50 ? 4 : 0);
      if (d + 12 > start || u32(d) !== crc || u32(d + 4) !== compressed || u32(d + 8) !== size) reject();
      localEnd = d + 12;
    } else if (u32(offset + 14) !== crc || u32(offset + 18) !== compressed || u32(offset + 22) !== size) reject();
    if (localEnd > start || ranges.some(([a, z]) => offset < z && localEnd > a)) reject();
    ranges.push([offset, localEnd]);
    const bytes = method === 0 ? Buffer.from(b.subarray(data, finish))
      : inflateRawSync(b.subarray(data, finish), {maxOutputLength: Math.max(1, size)});
    if (bytes.length !== size || crc32(bytes) !== crc) reject();
    files.set(name, bytes);
    p += 46 + n + extra + comment;
  }
  ranges.sort((a, z) => a[0] - z[0]);
  if (p !== end || ranges[0][0] !== 0 || ranges.at(-1)[1] !== start
      || ranges.some((r, i) => i && ranges[i - 1][1] !== r[0])) reject();
  return files;
}
