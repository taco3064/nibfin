/** Validate a stable GitHub database ID without numeric conversion. */
export function githubId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError('GitHub ID must be a canonical positive decimal string');
  }
  return value;
}

/** Return canonical comparison coordinates; this performs no identity lookup. */
export function repositoryCoordinates(owner, repository) {
  if (typeof owner !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner)
      || owner.includes('--')) {
    throw new TypeError('Invalid repository owner');
  }
  if (typeof repository !== 'string' || !/^[a-z0-9_.-]{1,100}$/i.test(repository)
      || repository === '.' || repository === '..') {
    throw new TypeError('Invalid repository name');
  }
  owner = owner.toLowerCase();
  repository = repository.toLowerCase();
  return {owner, repository, key: `${owner}/${repository}`};
}

/** A routing index only; a label never proves registration or authorization. */
export function memberRunnerLabel(userId) {
  return `nibfin-user-${githubId(userId)}`;
}

export {canonicalJSON, bodyDigest, prepareGrant, signGrant, verifyGrant} from './grants.mjs';
export {createGithubProvider, localGhTransport, parseGithubJson, publicDiagnostic, githubApiVersion} from './provider.mjs';
export {hookEvents, hookConfigurationAreas, safeObligationPath, parseCandidateObligations, validateHookObservation, reconcileCandidateObligations, validateCandidateFiles} from './obligations.mjs';


export {protectedSkills, skillForRole, outcomesForRole, parseStageResult, validateStageResult,
  byteDigest, contentIdentity, stageApplicability, createEvidence, compareEvidence, createCompletion,
  verifyCompletion, validateCompatibility, compareCompatibility} from './evidence.mjs';

export {exportAuthority, importAuthority, authoritySnapshot, verifyAuthority, synchronizeAuthority} from './authority.mjs';
export {createAuthorizationBoundary} from './authorization.mjs';

export {createAgentEnvironments, createAgentLifecycle} from './lifecycle.mjs';


export {actionsArtifactUpload, prepareCustodyManifest, validateCustodyManifest, bindCustodyPublication, artifactArchiveTransport, createArtifactCustody, publishCustody} from './custody.mjs';
export {actionsIssuer, actionsDiscovery, actionsJwks, createActionsVerifier,
  createSyntheticActionsVerifierForTest, verifyNativeNeeds} from './actions.mjs';
