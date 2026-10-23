import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
export const identityPaths = Object.freeze(['LICENSE', 'package.json', 'src/identity.mjs', 'src/index.mjs', 'src/requirements.mjs', 'src/authority.mjs', 'src/protected.mjs', 'src/agent.mjs', 'src/workspace.mjs', 'src/obligations.mjs', 'src/instructions/shape.md', 'src/instructions/deliver.md', 'src/instructions/accept.md', 'src/scope.mjs', 'src/instructions/scope.md']);
export async function identity() {
  const entries = [];
  for (const path of identityPaths) {
    const url = new URL(path, root);
    if (!(await lstat(url)).isFile()) throw new Error('Core identity requires regular files.');
    entries.push([path, (await readFile(url)).toString('base64')]);
  }
  const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  return { name: metadata.name, version: metadata.version,
    contentDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
export async function verifyInstallation(expected) {
  const actual = await identity();
  if (!expected || actual.name !== expected.name || actual.version !== expected.version ||
      actual.contentDigest !== expected.contentDigest) throw new Error('Installed Core identity mismatch.');
  return actual;
}
