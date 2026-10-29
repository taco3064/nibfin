import { createHmac, timingSafeEqual } from 'node:crypto';
import { digest } from './core.mjs';
import { Store } from './store.mjs';

export const dependencyWebhookSecret = entry => createHmac('sha256', Buffer.from(entry.secret, 'hex')).update('kairo:issue-dependencies:v1').digest('hex');
const reject = () => { throw Object.assign(new Error('Dependency webhook verification failed'), { code: 'DEPENDENCY_EVENT_INVALID' }); };
export async function relayDependencyEvent({ github, entry, execution, stateDirectory }, bytes, headers) {
  const signature = headers['x-hub-signature-256'];
  if (!['issue_dependencies', 'ping'].includes(headers['x-github-event']) || !/^[a-f0-9-]{16,64}$/i.test(headers['x-github-delivery'] || '') || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) reject();
  const expected = createHmac('sha256', dependencyWebhookSecret(entry)).update(bytes).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) reject();
  const p = JSON.parse(bytes.toString('utf8')), b = entry.binding;
  if (p.repository?.full_name !== b.repository || String(p.repository?.id) !== b.repositoryId || String(p.repository?.owner?.id) !== b.ownerId || String(p.sender?.id) !== b.ownerId) reject();
  if (headers['x-github-event'] === 'ping') return { status: 'VERIFIED_PING' };
  // GitHub also sends the blocking side; its counterpart in the blocked
  // repository is the canonical wakeup, avoiding duplicate dispatches.
  if (['blocking_added', 'blocking_removed'].includes(p.action)) return { status: 'IGNORED_BLOCKING_SIDE' };
  if (!['blocked_by_added', 'blocked_by_removed'].includes(p.action)) reject();
  const issue = p.blocked_issue;
  if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || !/^[\w-]+$/.test(issue.node_id || '') || issue.pull_request) reject();
  const live = await github.api('/repos/' + b.repository + '/issues/' + issue.number);
  if (live.node_id !== issue.node_id || live.pull_request || String(live.user?.id) !== b.ownerId) reject();
  if (!live.labels?.some(label => label.name === 'scope')) return {status:'IGNORED_NOT_SCOPE', issueId:issue.node_id};
  // The receiving Core independently validates membership, grant and live graph.
  // This owner-authenticated wakeup cannot satisfy a native label/close boundary.
  const operator = await github.api('/user');
  if (String(operator.id) !== b.ownerId || operator.type !== 'User' || execution.repository !== 'taco3064/kairo' || execution.workflowPath !== '.github/workflows/action-stage.yml' || execution.ref !== 'main') reject();
  const id = digest({ repositoryId: b.repositoryId, delivery: headers['x-github-delivery'] });
  const store = new Store(stateDirectory, 'dependency-event:' + id);
  return store.lease(async () => {
    const s = await store.read();
    if (s.attempted) return { status: s.accepted ? 'DUPLICATE' : 'WAITING', id };
    const saved = await store.transaction(s.revision, current => ({ ...current, attempted: true, payloadHash: digest(p), action: p.action, issueId: issue.node_id, delivery: headers['x-github-delivery'], attemptedAt: new Date().toISOString() }));
    await github.api('/repos/taco3064/kairo/actions/workflows/action-stage.yml/dispatches', 'POST', { ref: 'main', inputs: { issue_id: issue.node_id,issue_ref:b.repository.split('/')[1]+'#'+issue.number } });
    await store.transaction(saved.revision, current => ({ ...current, accepted: true }));
    return { status: 'DISPATCH_ACCEPTED', id, issueId: issue.node_id };
  });
}
