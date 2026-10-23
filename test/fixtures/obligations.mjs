import { digest, parseCandidateInventory } from '../../src/index.mjs';
export const reasons = {
  artifacts: 'Artifacts are empty because Scope requires only Git Tree source files; no retained extra output applies.',
  hooks: 'Hooks are empty because Git, repository, Husky and workspace configuration contain no applicable commit hooks.'
};
export function approval(obligations, scopeDigest, configuration) {
  const body = ['# Fixture approved Shape', ...Object.entries(reasons).filter(([kind]) => !obligations[kind].length).map(([, v]) => v),
    '```kairo-candidate', JSON.stringify(obligations), '```', ''].join('\n');
  const bytes = Buffer.from(JSON.stringify({ hooks: obligations.hooks })).toString('base64');
  const c = configuration ?? { complete: true, inspected: ['git', 'repository', 'husky', 'workspace'],
    sources: obligations.hooks.length ? [{ path: 'fixture-hook-setup.json', bytes, contentDigest: digest(bytes) }] : [], hooks: structuredClone(obligations.hooks), prerequisites: [] };
  return { schemaVersion: 1, body, configuration: c, validation: {
    approved: true, authorId: 'shape-author', validatorId: 'independent-validator', shapeDigest: digest(body), scopeDigest,
    configurationDigest: digest(c), inventoryDigest: digest(parseCandidateInventory(body)),
    emptyReasons: Object.fromEntries(Object.keys(reasons).map(k => [k, obligations[k].length ? null : reasons[k]]))
  } };
}
