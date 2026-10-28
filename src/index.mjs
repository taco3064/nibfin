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
  verifyCompletion, verifyEvidenceChain, validateCompatibility, compareCompatibility} from './evidence.mjs';

export {exportAuthority, importAuthority, authoritySnapshot, verifyAuthority, synchronizeAuthority} from './authority.mjs';
export {createAuthorizationBoundary} from './authorization.mjs';

export {createAgentEnvironments, createAgentLifecycle} from './lifecycle.mjs';


export {actionsArtifactUpload, prepareCustodyManifest, validateCustodyManifest, bindCustodyPublication, artifactArchiveTransport, createArtifactCustody, publishCustody} from './custody.mjs';
export {actionsIssuer, actionsDiscovery, actionsJwks, createActionsVerifier,
  createSyntheticActionsVerifierForTest, verifyNativeNeeds} from './actions.mjs';


export {checkDeploymentHealth, verifyDeployment, readDeploymentObservation,
  deploymentHealthDisposition, createDeploymentFinal} from './deployment.mjs';


export {observeRunners, observeRunnerBindings} from './runners.mjs';
export {selectInstructions, instructionSeparator} from './instructions.mjs';

export {workspaceLimits, captureWorkspace, verifyWorkspace, exportWorkspace, importWorkspace} from './workspace.mjs';
export {createAssigneeSelector} from './selection.mjs';

export {controlledIntent, createControlledOperations, observeControlledOperation} from './operations.mjs';
export {concurrencyVersion, nativeConcurrency, nativeExecutionPlan, parallelIssueWorkspace} from './concurrency.mjs';
export {createDependencyEvaluator} from './dynamic.mjs';

export {issueWakeup, createEventRelay} from './relay.mjs';

export {createRegistrationHost, createRegistrationArtifactChannel, registrationArtifactReader, openRegistrationResponse} from './registration.mjs';

export {scopeInstructions, checkPortfolio} from './portfolio.mjs';

export {observeGithubCI} from './ci.mjs';

export {publicationManifest, openPublicationJournal} from './publication.mjs';

export {createLinuxCodexBackend, linuxCodexProfile, codexProcess} from './codex.mjs';

export {publishPortfolio} from './publisher.mjs';

export {createShapeFlow} from './shape.mjs';

export {createLinuxClaudeBackend, linuxClaudeProfile} from './claude.mjs';
export {createLinuxGeminiBackend, linuxGeminiProfile} from './gemini.mjs';

export {createWindowsWslBackend, windowsLocalPath, windowsToWslPath, wslToWindowsPath, wslSession, wslLaunchEnvironment} from './wsl.mjs';
export {createHookRunner, hookProcess, verifyHookReceipt} from './hooks.mjs';

export {compareStageCollection} from './evidence.mjs';
export {createAcceptFlow} from './accept.mjs';

export {createRepairFlow,invalidateRepairEvidence} from './repair.mjs';
export {createCandidatePublication, createPublicationGit} from './candidate-publication.mjs';

export {observeFinalReview,createFinalReview,createProtectedMerge} from './final-review.mjs';

export {observeClosure, createCompletionFlow} from './completion.mjs';

export {observeRecoveryIncident,createRecoveryFlow,recoveryComment} from './recovery.mjs';
export {createDownstreamFanout, resolveFanoutWakeup} from './fanout.mjs';

export {createCore,coreStages,createDeliverFlow} from './core.mjs';

export {workflowVersion, workflowInput, projectIssue, workflowRoute, createWorkflowEntry} from './workflow.mjs';
export {workflowFiles, workflowInstallation} from './workflow-install.mjs';

export {releaseHash,releaseVersion,releaseComponents,configuration,validateReleaseCompatibility,verifyRelease} from './release.mjs';

export {protectedHostFiles,verifyApprovedSource,loadProtectedHost,loadProtectedDeployment} from './host-source.mjs';

export {createHostIdentityAdapters,createHostIdentityAdaptersForTest,hostedGithubTransport,githubEndpointPermission} from './host-identity.mjs';

export {createCustodyHost,custodySlotIdentity,createCustodyCurrent,retainedRoleRecord,createRetainedRoleBackend,recoverRoleCollection} from './custody-host.mjs';
export {loadApprovedInputs} from './host-source.mjs';

export {createHostRouting} from './host-routing.mjs';
export {createProtectedRegistration,registrationCustodySlots} from './registration-host.mjs';

export {createRoleBudget,createVerificationLane,verificationProcess,redactRuntimeText} from './verification.mjs';
export {nodeSourceIdentity,prepareNodeVerification} from './node-verification.mjs';
export {supportedRunnerDefaults,runnerConfiguration,preflightRunner,observeRunnerLocal} from './runner.mjs';
export {createProtectedRoleHost} from './role-host.mjs';
export {createContainerEgress,endpointProfiles} from './egress.mjs';
export {createEgressGateway,publicAddress,connectDestination,tlsServerName} from './egress-gateway.mjs';
export {executeSession,recoveryPolicy,capacityError,codexEvents,rejectSecrets} from './agent-session.mjs';

export {collaborationVersion,verifyRepositoryIdentity,validateMemberBinding} from './collaboration.mjs';
export {localRunnerCount,createLocalRunnerLifecycle} from './runner-lifecycle.mjs';
export {githubReadRequest,createGithubReadService,startGithubReadBroker,authorizedRepositories} from './agent-gh-read.mjs';
export {verificationBudget,validateBudget,runVerification} from './verification-runner.mjs';
