// Artifact-manifest algorithm reused from upstream src/workspace.mjs at
// d1b47d5e073cf15bdcdc1fbbec098401649878d9. Nibfin's workspace owner supplies
// bounded, symlink-free exact bytes and retains them in its immutable capture.
// No mutable Controller repository or credential is needed to identify outputs.
import {createHash} from 'node:crypto';
import {safeCandidatePath} from './candidate-contract.mjs';
export function sourceManifest(sources) {
  const manifest=[];
  for(const {bytes,...entry} of sources) {
    if(!safeCandidatePath(entry.path)||!Buffer.isBuffer(bytes))throw Error('Unsafe artifact source');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    manifest.push({...entry,size:bytes.length,sha256});
  }
  return manifest;
}
