import { createHash } from 'node:crypto';
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const check = (ok, message) => { if (!ok) throw Error(`Candidate: ${message}.`); };
const same = (a, b) => digest(a) === digest(b);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const fields = (x, keys) => check(x && Object.getPrototypeOf(x) === Object.prototype &&
  Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k)), 'unsupported record fields');
export function validateCandidatePath(p) {
  check(typeof p === 'string' && /^[\x21-\x7e]+$/.test(p) && !/[\\:%?#]/.test(p) &&
    !p.startsWith('/') && p.split('/').every(s => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git'), 'unsafe path');
  return p;
}
export function validateInventory(x) {
  fields(x, ['artifacts', 'hooks']); check(Array.isArray(x.artifacts) && Array.isArray(x.hooks), 'missing obligations');
  const used = [];
  for (const [kind, list] of Object.entries(x)) for (const item of list) {
    fields(item, kind === 'artifacts' ? ['path', 'purpose'] : ['path', 'event']); validateCandidatePath(item.path);
    check(typeof item.purpose === 'string' && item.purpose.trim().length > 0 ||
      kind === 'hooks' && ['pre-commit', 'prepare-commit-msg', 'commit-msg'].includes(item.event), 'invalid obligation');
    check(!used.some(p => p === item.path || p.startsWith(`${item.path}/`) || item.path.startsWith(`${p}/`)), 'conflicting obligation destinations');
    used.push(item.path);
  }
  return structuredClone({ artifacts: [...x.artifacts].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    // Hook order is execution semantics, not a set to canonicalize by path.
    hooks: [...x.hooks] });
}

// A line-oriented fenced-code scanner: an inventory nested in another fenced
// example is literal content, never an authoritative block.
function scanFences(body) {
  check(typeof body === 'string', 'missing Shape body');
  const blocks = [], prose = []; let fence = null, lines = [];
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        if (fence.inventory) blocks.push(lines.join('\n'));
        fence = null; lines = [];
      } else lines.push(line);
    } else {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})([^`~]*)$/);
      if (open) {
        const info = open[2].trim();
        check(!info.startsWith('kairo-candidate') || info === 'kairo-candidate', 'unsupported inventory fence info');
        fence = { marker: open[1][0], length: open[1].length, inventory: info === 'kairo-candidate' };
      } else prose.push(line);
    }
  }
  check(!fence, 'unterminated fenced example or inventory');
  return { blocks, prose: prose.join('\n') };
}
export function parseCandidateInventory(body) {
  const { blocks } = scanFences(body);
  check(blocks.length === 1, 'exactly one Candidate inventory required');
  let value;
  try { value = JSON.parse(blocks[0]); } catch { throw Error('Candidate: malformed inventory JSON.'); }
  // JSON permits repeated member names in many parsers. Reject them rather
  // than letting a later arrays member hide an earlier obligation declaration.
  const tokens = blocks[0].match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  const stack = [];
  tokens.forEach((token, i) => {
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (tokens[i + 1] === ':') {
      const key = JSON.parse(token), names = stack.at(-1);
      check(!names.has(key), 'duplicate JSON inventory field'); names.add(key);
    }
  });
  return validateInventory(value);
}

// Evidence is supplied by a protected host, not the Shape author or transport.
// The independent validator must compare Scope and configuration semantics;
// hashes here preserve that decision, they do not grant it authenticity.
export function validateCandidateObligations(evidence, expected, configuration) {
  fields(evidence, ['schemaVersion', 'body', 'configuration', 'validation']);
  check(evidence.schemaVersion === 1 && hash(expected.shapeDigest) && hash(expected.scopeDigest) &&
    digest(evidence.body) === expected.shapeDigest, 'approved Shape identity mismatch');
  const obligations = parseCandidateInventory(evidence.body), c = evidence.configuration, v = evidence.validation;
  check(configuration && same(configuration, c), 'fresh hook configuration differs from validated evidence');
  fields(c, ['complete', 'inspected', 'sources', 'hooks', 'prerequisites']);
  check(c.complete === true && same(c.inspected, ['git', 'repository', 'husky', 'workspace']) &&
    Array.isArray(c.sources) && Array.isArray(c.prerequisites), 'complete hook configuration evidence required');
  const seen = new Set();
  for (const source of c.sources) {
    fields(source, ['path', 'bytes', 'contentDigest']); validateCandidatePath(source.path);
    check(!seen.has(source.path), 'duplicate configuration source'); seen.add(source.path);
    check(typeof source.bytes === 'string' && Buffer.from(source.bytes, 'base64').toString('base64') === source.bytes &&
      source.contentDigest === digest(source.bytes), 'configuration source content mismatch');
  }
  check(c.hooks?.length === 0 || c.sources.length > 0, 'applicable hooks require configuration source evidence');
  check(same(obligations.hooks, validateInventory({ artifacts: [], hooks: c.hooks }).hooks), 'effective hook inventory mismatch');
  for (const prerequisite of c.prerequisites) {
    fields(prerequisite, ['kind', 'description', 'supported']);
    check(['installation', 'signing', 'credential', 'network', 'external-effect', 'tool'].includes(prerequisite.kind) &&
      typeof prerequisite.description === 'string' && prerequisite.description.trim(), 'invalid hook prerequisite');
    check(prerequisite.supported === true && !['credential', 'network', 'external-effect'].includes(prerequisite.kind),
      `unsupported mandatory hook prerequisite: ${prerequisite.kind}: ${prerequisite.description}`);
  }
  fields(v, ['approved', 'authorId', 'validatorId', 'shapeDigest', 'scopeDigest', 'configurationDigest', 'inventoryDigest', 'emptyReasons']);
  check(v.approved === true && typeof v.authorId === 'string' && v.authorId.trim() &&
    typeof v.validatorId === 'string' && v.validatorId.trim() && v.authorId !== v.validatorId &&
    v.shapeDigest === expected.shapeDigest && v.scopeDigest === expected.scopeDigest &&
    v.configurationDigest === digest(c) && v.inventoryDigest === digest(obligations), 'independent inventory validation mismatch');
  fields(v.emptyReasons, ['artifacts', 'hooks']);
  for (const kind of ['artifacts', 'hooks']) {
    const reason = v.emptyReasons[kind];
    check(obligations[kind].length ? reason === null : typeof reason === 'string' && reason.trim().length > 0 &&
      scanFences(evidence.body).prose.includes(reason), `missing explicit ${kind} applicability explanation`);
  }
  return { obligations, evidence: structuredClone(evidence) };
}
