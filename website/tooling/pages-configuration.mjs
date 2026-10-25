import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
export function validateConfiguration({ pages, branch, environment, policies }) {
  assert.equal(pages.build_type, 'workflow', 'Pages must publish using Actions');
  assert.equal(branch.name, 'main'); assert.equal(branch.protected, true, 'Main is not protected');
  const p = environment.deployment_branch_policy;
  assert(p, 'Missing deployment branch restrictions');
  if (p.custom_branch_policies) {
    assert(policies?.branch_policies?.length === 1, 'Environment must permit only main');
    assert.equal(policies.branch_policies[0].name, 'main');
    assert.equal(policies.branch_policies[0].type, 'branch');
  } else throw new Error('Require an explicit main-only environment policy; protected-branches mode can admit other branches');
}
if (process.argv[1]?.endsWith('/pages-configuration.mjs')) {
  assert.equal(process.env.GITHUB_REPOSITORY, 'taco3064/nibfin');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.equal(process.env.GITHUB_REF_PROTECTED, 'true');
  const root = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  async function get(path) {
    const r = await fetch(root + path, { headers: { ...(path === '/pages' ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(15000) });
    assert(r.ok, `Configuration readback ${path}: HTTP ${r.status}`); return r.json();
  }
  const data = { pages: await get('/pages'), branch: await get('/branches/main'), environment: await get('/environments/github-pages'), policies: await get('/environments/github-pages/deployment-branch-policies') };
  validateConfiguration(data);
  assert.equal(data.branch.commit.sha, process.env.GITHUB_SHA, 'Queued deployment is no longer current main');
  // Retain public configuration and approval rules, never request headers or tokens.
  writeFileSync('out/pages-configuration.json', JSON.stringify({ observedAt: new Date().toISOString(), ...data }, null, 2));
}
