import {gunzipSync} from 'node:zlib';
// Read the actual tar payload without extracting attacker-controlled paths.
export function inspectPackageArchive(archive, permittedPaths) {
  const tar = gunzipSync(archive);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error('Trailing tar data');
      return files;
    }
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const octal = text => {
      if (!/^[0-7]+$/.test(text.trim())) throw new Error('Invalid tar number');
      return parseInt(text.trim(), 8);
    };
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(field(148, 8))) throw new Error('Invalid tar checksum');
    const name = field(0, 100);
    const size = octal(field(124, 12));
    if (field(345, 155) || !['0', ''].includes(field(156, 1)) || !name.startsWith('package/')) {
      throw new Error(`Unsupported archive entry: ${name}`);
    }
    const path = name.slice(8);
    if (!permittedPaths.includes(path) || files.has(path)) throw new Error(`Forbidden or duplicate archive entry: ${path}`);
    offset += 512;
    if (offset + size > tar.length) throw new Error('Truncated tar entry');
    files.set(path, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing tar terminator');
}

