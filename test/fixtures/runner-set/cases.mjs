// All identities and observations are invented and public-safe.
export const runner = (id, member = 11, patch = {}) => ({ id, member, binding: id,
  labels: ['self-hosted', 'linux', `member-${member}`], os: 'linux', group: 7,
  repositories: [101], status: 'online', busy: false, permission: 'write',
  authorized: true, isolated: true, ...patch });
export const initial = () => ({ order: [11, 22], selector: {
  repository: 101, group: 7, os: 'linux', labels: ['self-hosted', 'linux'] },
listing: { http: 200, complete: true, fresh: true, total: 2, pages: [[runner(1), runner(2, 22)]] } });
const cases = [];
function add(id, change, status, member = null, recipients = []) {
  const input = initial(); change(input);
  cases.push({ id, input, expected: { status, member, recipients } });
}
add('trusted-multiple', x => { x.listing.pages.push([runner(3)]); x.listing.total++; }, 'candidate', 11, [1, 3]);
for (const [id, patch] of Object.entries({
  'unauthorized-online': { authorized: false },
  'unauthorized-busy': { authorized: false, busy: true },
  'unauthorized-offline': { authorized: false, status: 'offline' },
  'unknown-binding': { binding: null }, 'new-registration-id': { binding: 9 },
  'downgrade-read': { permission: 'read' }, 'downgrade-triage': { permission: 'triage' },
  'lost-access': { permission: null }, 'wrong-member': { member: 22 },
  'missing-isolation': { isolated: false }
})) add(id, x => { x.listing.pages[0].push(runner(3, 11, patch)); x.listing.total++; }, 'blocked', 11, [1, 3]);
for (const [id, patch] of Object.entries({ 'wrong-os': { os: 'windows' },
  'missing-label': { labels: ['self-hosted', 'member-11'] },
  'wrong-group': { group: 8 }, 'wrong-repository': { repositories: [202] },
  'offline-fallback': { status: 'offline' }
})) add(id, x => Object.assign(x.listing.pages[0][0], patch), 'candidate', 22, [2]);
add('busy-preserves-rank', x => { x.listing.pages[0][0].busy = true; }, 'candidate', 11, [1]);
add('all-offline', x => { for (const r of x.listing.pages[0]) r.status = 'offline'; }, 'waiting');
add('empty-complete', x => { x.listing.pages = [[]]; x.listing.total = 0; }, 'waiting');
for (const status of [401, 403, 404, 429, 500]) add(`http-${status}`, x => { x.listing.http = status; }, 'unknown');
add('incomplete', x => { x.listing.complete = false; }, 'unknown');
add('stale', x => { x.listing.fresh = false; }, 'unknown');
add('missing-page', x => { x.listing.total = 3; }, 'unknown');
add('malformed-page', x => { x.listing.pages = [null]; }, 'unknown');
add('malformed-runner', x => { delete x.listing.pages[0][0].labels; }, 'unknown');
add('duplicate-id', x => { x.listing.pages[0][1].id = 1; }, 'unknown');
for (const [id, repositories] of Object.entries({
  'access-null-id': [null], 'access-string-id': ['101'], 'access-zero-id': [0],
  'access-negative-id': [-1], 'access-fractional-id': [1.5],
  'access-unsafe-id': [Number.MAX_SAFE_INTEGER + 1],
  'access-mixed-id': [101, null], 'access-sparse-id': Array(1)
})) add(id, x => { x.listing.pages[0][0].repositories = repositories; }, 'unknown');
export { cases };
export const attacks = [
  { id: 'registration', phase: 'after-inspection', kind: 'register', runner: runner(3, 11, { authorized: false }), receiver: 3 },
  { id: 'relabel', phase: 'while-queued', kind: 'relabel', idTarget: 3, patch: { labels: ['self-hosted', 'linux', 'member-11'] }, receiver: 3 },
  { id: 'group-expansion', phase: 'before-receipt', kind: 'group', idTarget: 3, patch: { group: 7 }, receiver: 3 },
  { id: 'access-expansion', phase: 'while-queued', kind: 'access', idTarget: 3, patch: { repositories: [101] }, receiver: 3 },
  { id: 'binding-revocation', phase: 'before-receipt', kind: 'binding', idTarget: 1, patch: { binding: null }, receiver: 1 },
  { id: 'member-downgrade', phase: 'while-queued', kind: 'permission', idTarget: 1, patch: { permission: 'read' }, receiver: 1 },
  { id: 'nonreceipt-reassignment', phase: 'after-nonreceipt-requeue', kind: 'register', runner: runner(3, 11, { authorized: false }), receiver: 3 }
].map(a => {
  const input = initial();
  if (['relabel', 'group-expansion', 'access-expansion'].includes(a.id)) {
    const patch = a.id === 'relabel' ? { labels: ['self-hosted', 'linux'] } :
      a.id === 'group-expansion' ? { group: 8 } : { repositories: [202] };
    input.listing.pages[0].push(runner(3, 11, { authorized: false, ...patch })); input.listing.total++;
  }
  return { id: a.id, initial: input, receiver: a.receiver,
    changes: [{ phase: a.phase, kind: a.kind, id: a.idTarget, patch: a.patch, runner: a.runner }] };
});
