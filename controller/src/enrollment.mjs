import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoPath } from './github.mjs';
import { UPSTREAM_REPOSITORY, verifyupstreamOwner } from './owner-identity.mjs';

// Bootstrap produces an inspectable local caller and compares the live version.
// It does not register runners, install credentials or publish Core source.
export async function enrollment(github, root, repository, options = {}) {
  const target = await github.repository(repository);
  let nibfinOwnerGitHubUserId = null;
  if (!target.private) {
    const source = await github.repository(UPSTREAM_REPOSITORY);
    nibfinOwnerGitHubUserId = await verifyupstreamOwner(github, { nibfinOwnerGitHubUserId: String(source.owner?.id) });
    if (target.owner?.type !== 'User' || String(target.owner.id) !== nibfinOwnerGitHubUserId) throw new Error('Public enrollment requires the anchored upstream Owner');
  }
  const initialized = await github.initialize(repository);
  const privateRepo = initialized.entrypoint === 'private-reusable';
  if (privateRepo && !/^[a-f0-9]{40}$/.test(options.coreCommit || '')) throw new Error('Private enrollment requires an approved full Core commit SHA');
  const workflow = (await readFile(join(root, 'examples/workflows', privateRepo ? 'private-caller.yml' : 'public-caller.yml'), 'utf8')).replaceAll('CORE_COMMIT_SHA', options.coreCommit || '');
  let existing;
  try { existing = await github.api(`${repoPath(repository)}/contents/.github/workflows/nibfin.yml?ref=${encodeURIComponent(initialized.defaultBranch)}`); }
  catch (error) { if (error.status !== 404) throw error; }
  const current = existing?.encoding === 'base64' ? Buffer.from(existing.content, 'base64').toString('utf8') : null;
  const branch = await github.api(`${repoPath(repository)}/branches/${encodeURIComponent(initialized.defaultBranch)}`);
  const workflows = await github.list(`${repoPath(repository)}/actions/workflows`, 'workflows');
  const runners = privateRepo ? await github.list(`${repoPath(repository)}/actions/runners`, 'runners') : [];
  const runnerKeyConfigured = privateRepo ? null : (await github.list(`${repoPath(repository)}/actions/secrets`, 'secrets')).some(secret => secret.name === 'UPSTREAM_RUNNER_KEY');
  return { ...initialized, workflow, runnerKeyConfigured, nibfinOwnerGitHubUserId, workflowStatus: current === workflow ? 'matched' : current === null ? 'missing' : 'different', defaultHead: branch.commit.sha,
    workflows: workflows.map(w=>({id:w.id,path:w.path,state:w.state})),
    runners: runners.map(r=>({id:r.id,name:r.name,status:r.status})),
    executionAuthorized: false, next: privateRepo ? 'Install or review the caller, then verify the signed runtime with doctor. Enrollment does not authorize execution.' : 'Install the hosted dispatch caller, enroll a repository-bound runner key, then obtain a signed grant pinned to the root identity and binding. Missing keys never dispatch.' };
}
