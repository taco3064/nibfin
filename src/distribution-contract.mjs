export const distributionAPI = Object.freeze({
  version: 1,
  readiness: 1,
  installation: 1,
  transition: 1,
  runtime: 2,
  workflow: 1,
  skills: 1,
  source: 1,
  recovery: 1,
  jobAdmission: 1,
  evidence: 1,
  nativeHost: 1,
  nativeNotifications: 1,
  githubTransport: 1,
  deliveryRevision: 1,
  protectedDiagnosis: 1,
});
// Each responsibility has ONE executable public owner. Controller is provenance,
// never an imported parallel lifecycle or an end-user installation prerequisite.
export const distributionOwners = Object.freeze(
  [
    {
      responsibility: 'runtime',
      owner: 'src/runtime.mjs',
      input: 'src/runtime.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'workflow',
      owner: 'src/workflow.mjs',
      input: 'src/action-stage.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'planning',
      owner: 'src/delivery-planner.mjs',
      input: 'src/core.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'configuration',
      owner: 'src/runner.mjs',
      input: 'src/runtime-configuration.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'schema',
      owner: 'src/evidence.mjs',
      input: 'src/schema.mjs',
      disposition: 'retained',
    },
    {
      responsibility: 'authority',
      owner: 'src/authority.mjs',
      input: 'src/authority.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'skills',
      owner: 'src/instructions.mjs',
      input: 'src/skills.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'hold-pause',
      owner: 'src/owner-hold.mjs',
      input: 'src/owner-hold.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'isolation-preflight',
      owner: 'src/runner.mjs',
      input: 'docs/rootless-hardening.md',
      disposition: 'adapted',
    },
    {
      responsibility: 'routing',
      owner: 'src/selection.mjs',
      disposition: 'retained',
    },
    { responsibility: 'custody', owner: 'src/custody.mjs', disposition: 'retained' },
    { responsibility: 'events', owner: 'src/relay.mjs', disposition: 'retained' },
    {
      responsibility: 'recovery',
      owner: 'src/rescue.mjs',
      input: 'src/rescue.mjs',
      disposition: 'adapted',
    },
    {
      responsibility: 'job-admission',
      owner: 'src/runner-job-gate.mjs',
      disposition: 'reused',
    },
    {
      responsibility: 'lifecycle-contract',
      owner: 'src/core-contract.mjs',
      disposition: 'consolidated',
    },
    {
      responsibility: 'candidate-delivery',
      owner: 'src/core-deliver.mjs',
      disposition: 'consolidated',
    },
    {
      responsibility: 'base-revision',
      owner: 'src/delivery-revision.mjs',
      disposition: 'consolidated',
    },
    {
      responsibility: 'protected-diagnosis',
      owner: 'src/protected-rescue-policy.mjs',
      disposition: 'consolidated',
    },
    {
      responsibility: 'github-transport',
      owner: 'src/github-transport.mjs',
      disposition: 'consolidated',
    },
    {
      responsibility: 'github-observation',
      owner: 'src/github-conditional.mjs',
      disposition: 'consolidated',
    },
    {
      responsibility: 'github-cooldown',
      owner: 'src/github-rate-limit.mjs',
      disposition: 'consolidated',
    },
  ].map(Object.freeze),
);
export const distributionProfiles = Object.freeze([
  Object.freeze({
    id: 'source-contract',
    node: '22.23.3',
    npm: '10.9.9',
    network:
      'credential-free offline fixtures; locked dependency acquisition before execution',
    status: 'Supported',
    scope: 'source-contract only',
  }),
  Object.freeze({
    id: 'member-runtime',
    node: '22.23.3',
    npm: '10.9.9',
    host: 'linux-x64 or wsl-linux-x64',
    authentication:
      'execution account stored gh login; independent member ' +
      'model login; no GH_TOKEN/GITHUB_TOKEN overrides',
    isolation: 'rootless-docker; pinned agent images; separate credential spaces',
    network: 'internal-docker-gateway; configured dependency/model egress; system CA',
    status: 'Unverified',
    scope: 'implemented adapters; no CLI/platform/model/product certification',
  }),
  Object.freeze({
    id: 'commit-hooks',
    network: 'none',
    authentication: 'none',
    isolation: 'rootless-docker',
    status: 'Unverified',
    scope: 'source process fixtures only',
  }),
  Object.freeze({
    id: 'runner-job-admission',
    host: 'linux /proc and official pinned Worker binary',
    network: 'finite authenticated public GitHub GET reads outside Agent',
    authentication: 'actual service account stored gh login',
    status: 'Unverified',
    scope:
      'upstream disposable probe evidence and local process ' +
      'doubles; no production cutover',
  }),
  Object.freeze({
    id: 'private-repository',
    status: 'Unsupported',
    scope: 'outside product scope',
  }),
]);
