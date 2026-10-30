// Fixed official source, including its stable repository identity. A repository
// recreated under the same pathname cannot replace this trust anchor.
export const UPSTREAM_REPOSITORY = 'retired-private-source';
export const UPSTREAM_REPOSITORY_ID = '1424023266';
export async function verifyupstreamOwner(github, config, policy, actor) {
  const id = config.nibfinOwnerGitHubUserId;
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || policy && policy.nibfinOwnerGitHubUserId !== id) throw new Error('upstream Owner identity is missing or differs from signed policy');
  const source = await github.repository(UPSTREAM_REPOSITORY);
  if (String(source.id) !== UPSTREAM_REPOSITORY_ID || source.owner?.type !== 'User' || String(source.owner.id) !== id) throw new Error('Official upstream repository Owner identity changed');
  if (actor !== undefined) {
    if (typeof actor !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(actor)) throw new Error('Invalid grant actor identity');
    const user = await github.api(`/users/${encodeURIComponent(actor)}`);
    if (user.type !== 'User' || String(user.id) !== id) throw new Error('Signed grant actor is not the upstream Owner');
  }
  return id;
}
