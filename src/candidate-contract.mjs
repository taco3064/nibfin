// Adapted from taco3064/kairo@d1b47d5e073cf15bdcdc1fbbec098401649878d9.
// See docs/kairo-reuse.md for ownership, adapters and deviations.
import { validateSchema } from './candidate-schema.mjs';
import {parseRequirementsDocument} from './requirements-document.mjs';

export const candidateContractSchema = {
  type: 'object', additionalProperties: false, required: ['artifacts', 'hooks'], properties: {
    artifacts: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['path', 'purpose'], properties: {path: {type:'string'}, purpose: {type:'string'}}}},
    hooks: {type: 'array', items: {type:'object', additionalProperties:false, required:['path', 'event'], properties: {path:{type:'string'}, event:{type:'string', enum:['pre-commit', 'prepare-commit-msg', 'commit-msg']}}}},
  },
};
export function safeCandidatePath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/.test(path) && path.split('/').every(p => p && !['.', '..', '.git'].includes(p.toLowerCase()));
}
export function candidateContract(body) {
  const document=parseRequirementsDocument(body||'');body=document.shape??document.scope;
  const blocks = [...(body || '').matchAll(/^```kairo-candidate\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) throw new Error('Shape must contain exactly one kairo-candidate obligations block');
  return validateCandidateInventory(JSON.parse(blocks[0][1]));
}
export function validateCandidateInventory(value) {
  const contract = validateSchema(value, candidateContractSchema);
  for (const kind of ['artifacts', 'hooks']) {
    if (new Set(contract[kind].map(x => x.path)).size !== contract[kind].length) throw new Error('Duplicate candidate obligation');
    for (const entry of contract[kind]) if (!safeCandidatePath(entry.path) || (kind === 'artifacts' && !entry.purpose.trim())) throw new Error('Invalid candidate obligation path or purpose');
  }
  return contract;
}
