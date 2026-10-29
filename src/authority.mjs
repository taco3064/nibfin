import {canonicalJSON, bodyDigest, verifyGrant} from './grants.mjs';
import {contentIdentity} from './evidence.mjs';
import {repositoryCoordinates,githubId} from './identity.mjs';

const fail = category => { throw new TypeError(`authority:${category}`); };
const copy = value => JSON.parse(canonicalJSON(value));
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
function fields(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || !same(Object.keys(value).sort(), keys.split(' ').sort())) fail('schema');
}
function token(value) {
  if (typeof value !== 'string' || !value.length || /[\x00-\x1f*]/.test(value)) fail('schema');
}
function source(value) {
  if(typeof value!=='string')fail('source');
  const issue=/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/.exec(value);
  try{if(!issue||repositoryCoordinates(issue[1],issue[2]).key!==issue[1]+'/'+issue[2])fail('source');githubId(issue[3]);}
  catch{fail('source');}
}
function components(values) {
  if (!Array.isArray(values) || !values.length) fail('completeness');
  const ids = new Set();
  for (const value of values) {
    fields(value, 'id kind body references'); token(value.id);
    if (ids.has(value.id)) fail('completeness');
    ids.add(value.id);
    if (!['section', 'attachment', 'reference'].includes(value.kind)
        || typeof value.body !== 'string' || !Array.isArray(value.references)) fail('schema');
    value.references.forEach(token);
    if (new Set(value.references).size !== value.references.length) fail('completeness');
    // Attachment bodies encode complete bytes, not a download URL.
    if (value.kind === 'attachment'
        && Buffer.from(value.body, 'base64').toString('base64') !== value.body) fail('schema');
  }
  for (const value of values) for (const id of value.references) if (!ids.has(id)) fail('completeness');
}
function manifestFor(v) {
  return {version: 1, source: v.source, revision: v.revision,
    components: v.components.map(c => ({id: c.id, kind: c.kind, hash: bodyDigest(c.body), references: c.references}))};
}
function validate(input) {
  const v = copy(input);
  fields(v, 'version source revision approvalId cycle components manifest identity');
  if (v.version !== 1) fail('version');
  source(v.source); token(v.revision); token(v.approvalId); token(v.cycle); components(v.components);
  if (!same(v.manifest, manifestFor(v))) fail('integrity');
  const {identity, ...payload} = v;
  if (identity !== contentIdentity({kind: 'nibfin-authority-export-v1', payload})) fail('integrity');
  return v;
}
/** Construct an UNAPPROVED export for separate Owner review/signing. */
export function exportAuthority(input) {
  try {
    const v = copy(input);
    fields(v, 'source revision approvalId cycle components');
    const payload = {version: 1, ...v, manifest: manifestFor(v)};
    return validate({...payload, identity: contentIdentity({kind: 'nibfin-authority-export-v1', payload})});
  } catch (error) { safeThrow(error); }
}
/** Parse and check structural integrity only; never establishes approval. */
export function importAuthority(input) {
  try { return validate(typeof input === 'string' ? JSON.parse(input) : input); }
  catch (error) { safeThrow(error); }
}
/** Exact full representation consumed by the existing Grant snapshot contract. */
export function authoritySnapshot(input) {
  const v = importAuthority(input);
  const body = canonicalJSON(v);
  return {source: v.source, revision: v.revision, body, hash: bodyDigest(body)};
}
function bindingFor(v) {
  return {identity: v.identity, approvalId: v.approvalId, cycle: v.cycle, snapshot: authoritySnapshot(v)};
}
const categories = ['schema', 'version', 'source', 'completeness', 'integrity', 'expectation', 'approval',
  'authorization', 'previous', 'cycle'];
function safeThrow(error) {
  const category = typeof error?.message === 'string' && error.message.startsWith('authority:')
    ? error.message.slice(10) : 'schema';
  fail(categories.includes(category) ? category : 'schema');
}
/** No I/O. Approval comes from a signed Grant AND independent current context. */
export function verifyAuthority(input, context) {
  try {
    const {grant, grantContext, expected} = context ?? {};
    const v = importAuthority(input);
    fields(expected, 'source revision approvalId cycle');
    if (!same(expected, {source: v.source, revision: v.revision, approvalId: v.approvalId, cycle: v.cycle})) fail('expectation');
    // Never substitute export-derived expectations into verifyGrant.
    if (!same(authoritySnapshot(v), grantContext?.expectedAuthority)) fail('expectation');
    if (!verifyGrant(grant, grantContext).ok) fail('approval');
    return {ok: true, category: 'approved', binding: bindingFor(v)};
  } catch (error) {
    try { safeThrow(error); } catch (safe) { return {ok: false, category: safe.message.slice(10)}; }
  }
}
function checkBinding(v) {
  fields(v, 'identity approvalId cycle snapshot');
  const exported = importAuthority(v.snapshot?.body);
  if (!same(v, bindingFor(exported))) fail('previous');
}
/** Pure compare-and-replace proposal; the trusted caller owns atomic persistence. */
export function synchronizeAuthority(input) {
  try {
    const {active, expectedPrevious, replacement, verification, authorization} = input;
    checkBinding(active); checkBinding(expectedPrevious);
    if (!same(active, expectedPrevious)) fail('previous');
    const checked = verifyAuthority(replacement, verification);
    if (!checked.ok) fail(checked.category);
    const next = checked.binding;
    if (next.snapshot.source !== active.snapshot.source) fail('source');
    fields(authorization, 'previousIdentity replacementIdentity cycle');
    if (!same(authorization, {previousIdentity: active.identity, replacementIdentity: next.identity, cycle: next.cycle})) fail('authorization');
    const changed = !same(active, next);
    if (changed && active.cycle === next.cycle) fail('cycle');
    return {status: changed ? 'replaced' : 'unchanged', active: copy(next), previous: copy(active),
      invalidated: changed ? ['grants', 'evidence', 'completion'] : []};
  } catch (error) { safeThrow(error); }
}
