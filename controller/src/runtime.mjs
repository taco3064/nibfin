import {installIndependentTransport} from './independent-transport.mjs';
import { verifyWebsiteRevision, attachWebsiteRevision } from './website-revision.mjs';
import { attachAssigneeCoreRepair } from './assignee-revision.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { mapReads } from './parallel.mjs';
import { currentActionJob, waitForActionIdentity } from './action-identity.mjs';
import { join, resolve } from 'node:path';
import { binding, canonical, digest, plan, reviewOutcome, validateWorkflowPins, continuedDeliveryBase } from './core.mjs';
import { coreDigest, verifyGrant, verifyCoreUpgrade, outside } from './authority.mjs';
import { Store } from './store.mjs';
import { GitHub, repoPath } from './github.mjs';
import { CodexAgent } from './agent.mjs';
import { Workspace } from './workspace.mjs';
import { selectSkill, validateSkillPolicy } from './skills.mjs';
import { candidateContract } from './candidate-contract.mjs';
import { runHooks } from './hooks.mjs';
import { verifyDeliveryInputs, selectDeliveryInput } from './delivery-input.mjs';
import { verifyOwnerHolds } from './owner-hold.mjs';
import { verifyRequirementRevision, attachRequirementRevision, verifyRevisionHolds, attachRevisionCoreRepair } from './requirement-revision.mjs';
import { verifyAssigneeRevision, attachAssigneeRevision } from './assignee-revision.mjs';
import { loadIssueScopes } from './issue-scope.mjs';
import { readBindings } from './runner-binding.mjs';
import {verifyRescueInvocation} from './rescue-policy.mjs';
import { verifyOrigin, dispatchGrantIdentity } from './dispatch.mjs';
import { resumeDynamic, dynamicDoctor } from './dynamic.mjs';
import { verifyKairoOwner } from './owner-identity.mjs';
import { verifyActionRun, requireDistinctActionRuns } from './action-provenance.mjs';
import {runtimeConfigurationHash,verifyRuntimeHardening} from './runtime-configuration.mjs';
export {runtimeConfigurationHash} from './runtime-configuration.mjs';
import { validateDeploymentPolicy, readDeploymentProof, observeMergedDeployment, deploymentProofHash, issueDeploymentDisposition } from './deployment.mjs';
import { readDeploymentFailureLog, recoveryComment, verifyRecoverySource, requireRepairAuthorization } from './recovery.mjs';

const issueKey = issue => digest({ id: issue.id, repository: issue.repository });
const envelope = (grant, issue, stage, run, artifacts) => ({ schemaVersion: 1, stage, outcome: run.result.outcome, reportedOutcome: run.reportedOutcome || run.result.outcome, reportedFailureClass: run.reportedFailureClass || run.result.failureClass || 'none', failureClass: run.result.failureClass || 'none', subject: issue.id, ...binding(grant.manifest, grant.policy), executionId: run.executionId, artifactIdentities: artifacts, ...(run.deliveryInputs ? { deliveryInputs: run.deliveryInputs } : {}), ...(run.upstreamHandoff ? { upstreamHandoff: run.upstreamHandoff } : {}), evidenceReferences: [run.evidencePath, ...(run.transcriptPath ? [run.transcriptPath] : []), ...run.result.evidenceReferences], blockingFindings: run.result.blockingFindings, contractConflicts: run.result.contractConflicts || [], proposedNextTransition: null, skill: run.skill, resultHash: run.resultHash });

export class Runtime {
  constructor(config, root, github, agent, workspaceFactory, environment = process.env) {
    this.config = config; this.root = root; this.github = github; this.environment = environment;
    this.executionContext = { kind: 'local-operator', runnerName: config.runnerId };
    this.agent = agent || new CodexAgent(config.agent, root, config.stateDirectory);
    this.workspaceFactory = workspaceFactory || ((path, issue) => new Workspace(path, issue, github.token));
  }
  static async connect(configPath, root) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (!outside(root, configPath) || !outside(root, config.stateDirectory) || !outside(root, config.publicKeyPath) || !outside(config.stateDirectory, config.agent.authDirectory)) throw new Error('Trusted config, public key, state and dedicated Agent credentials must be outside participant/Core workspaces');
    if (config.credentialFile && (!outside(root, config.credentialFile) || !outside(config.stateDirectory, config.credentialFile) || !outside(config.agent.authDirectory, config.credentialFile))) throw new Error('Controller credential must remain outside Core, state and Agent mounts');
    if (config.publicRunner) for (const path of [config.publicRunner.rootKeyPath, config.publicRunner.registryPath]) {
      if (typeof path !== 'string' || !outside(root, path) || !outside(config.stateDirectory, path) || !outside(config.agent.authDirectory, path)) throw new Error('Runner identity and registry must remain outside workspaces and Agent mounts');
    }
    const runtime = new Runtime(config, root, await GitHub.connect(config.credentialFile));
    await installIndependentTransport(runtime); return runtime;
  }
  async grant() {
    return this.github.measure ? this.github.measure('authority', () => this.grantFresh()) : this.grantFresh();
  }
  actionExecutionPolicy(grant) {
    if(this.transport)return {...this.transport.execution,outboxRepositoryId:grant.policy.actionExecution.repositoryId};
    const limits = this.coreUpgrade?.executionLimits;
    const policy=limits ? {...grant.policy.actionExecution, workflowBlob:limits.workflowBlob,
      previousWorkflowBlob:limits.previousWorkflowBlob} : grant.policy.actionExecution;
    return this.coreUpgrade?.actionWorkflowBlob?{...policy,workflowBlob:this.coreUpgrade.actionWorkflowBlob,
      previousWorkflowBlob:policy.workflowBlob,...(policy.previousWorkflowBlob?{originalWorkflowBlob:policy.previousWorkflowBlob}:{})}:policy;
  }
  async grantFresh() {
    if (this.config.controlMode === 'owner-project') {
      this.ownerGrant ||= this.readGrant().catch(e => { this.ownerGrant = null; throw e; });
      return this.ownerGrant;
    }
    if (this.config.actionExecution?.identityMode === 'local-gh') return this.readGrant();
    if (!this.config.actionExecution) return this.readGrant();
    return waitForActionIdentity(attempt => attempt > 1 && this.github.freshReadObservation
      ? this.github.freshReadObservation(() => this.readGrant()) : this.readGrant(),
    { context: { runId: this.environment.GITHUB_RUN_ID, runAttempt: this.environment.GITHUB_RUN_ATTEMPT } });
  }
  async readGrant() {
    await installIndependentTransport(this);
    const bundle=await this.github.grant(this.config.grantSource), publicKey=await readFile(this.config.publicKeyPath,'utf8');
    const grant = verifyGrant(bundle,publicKey);
    this.deliveryInputs = verifyDeliveryInputs(bundle.deliveryInputs, grant, publicKey);
    this.ownerExecutionHolds = verifyOwnerHolds(bundle.ownerExecutionHolds, grant, publicKey);
    if(bundle.requirementRevision){
      const revision=verifyRequirementRevision(bundle.requirementRevision,grant,publicKey);
      verifyRevisionHolds(revision,this.ownerExecutionHolds);
      attachRequirementRevision(grant,revision);
    }
    if(bundle.assigneeOrderRevision) attachAssigneeRevision(grant,
      verifyAssigneeRevision(bundle.assigneeOrderRevision,grant,publicKey,digest(bundle.requirementRevision)));
    if(bundle.websiteRevision) attachWebsiteRevision(grant,verifyWebsiteRevision(bundle.websiteRevision,grant,publicKey,digest(bundle.requirementRevision),digest(bundle.assigneeOrderRevision)));
    if ((grant.policy.controlMode === 'owner-project') !== (this.config.controlMode === 'owner-project')) throw Error('Owner project mode must match local configuration');
    validateSkillPolicy(grant.policy);
    if (grant.manifest.schemaVersion === 2 && grant.policy.stateDirectory !== this.config.stateDirectory) throw new Error('Dynamic state directory differs from signed coordination root');
    const installedDigest=await coreDigest(this.root);
    if(grant.policy.runnerId!==this.config.runnerId)throw new Error('Runner differs from owner grant');
    // During a live rollout both exact Owner-approved installations may exist.
    // Select by actual bytes, then verify that amendment against this authority.
    const amendments=[bundle.coreUpgrade,...(Array.isArray(bundle.coreUpgrades)?bundle.coreUpgrades:[])].filter(Boolean);
    const amendment=amendments.find(a=>a.payload?.toCoreDigest===installedDigest);
    this.coreUpgrade=amendment?verifyCoreUpgrade(amendment,grant,installedDigest,publicKey):null;
    this.agent.githubRead=this.coreUpgrade?.agentGithubRead===true;
    if(grant.policy.coreDigest!==installedDigest&&!this.coreUpgrade)throw new Error('Installed Core pin differs from owner grant');
    this.installedCoreDigest=installedDigest;
    const revisionRepairs=(Array.isArray(bundle.revisionCoreRepairs)?bundle.revisionCoreRepairs:[])
      .filter(a=>a.payload?.toCoreDigest===installedDigest);
    if(revisionRepairs.length>1)throw Error('Ambiguous requirement Core repair amendments');
    if(revisionRepairs.length)this.revisionCoreRepair=attachRevisionCoreRepair(revisionRepairs[0],grant,publicKey,installedDigest);
    const assigneeRepairs=(bundle.assigneeCoreRepairs||[]).filter(a=>a.payload?.toCoreDigest===installedDigest);
    if(assigneeRepairs.length>1)throw Error('Ambiguous Assignee Core repair amendments');
    if(assigneeRepairs.length)attachAssigneeCoreRepair(assigneeRepairs[0],grant,publicKey,installedDigest);
    if (grant.policy.runtimeHash !== runtimeConfigurationHash(this.config)) {
      const hardenings=[bundle.runtimeHardening,...(bundle.runtimeHardenings||[])].filter(a=>a?.payload?.toCoreDigest===installedDigest&&a.payload.toRuntimeHash===runtimeConfigurationHash(this.config));
      if(hardenings.length!==1)throw new Error('Runtime settings differ from approved policy');
      this.runtimeHardening=verifyRuntimeHardening(hardenings[0],grant,this.config,installedDigest,publicKey);
    }
    if (grant.policy.agentImage !== this.config.agent.image) throw new Error('Agent image differs from approved policy');
    this.agent.executionTimeoutMs = this.coreUpgrade?.executionLimits?.agentTimeoutMs || null;
    if (!this.config.proposalSource || digest(await this.github.text(this.config.proposalSource)) !== grant.manifest.proposalHash) throw new Error('Current proposal source differs from the approved Freeze');
    const env = this.environment;
    if (grant.policy.executionMode === 'actions-v1') {
      const originalExecution = grant.policy.actionExecution;
      const execution = this.actionExecutionPolicy(grant);
      if (grant.manifest.schemaVersion !== 2 || !execution || digest(originalExecution) !== digest(this.config.actionExecution) || !this.rescueInvocation && (env.GITHUB_REPOSITORY !== execution.repository || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) throw new Error('Actions mode requires its exact signed private execution workflow and trusted runtime configuration');
      if (!/^[a-f0-9]{64}$/.test(execution.coordinationHostId || '') || digest((await readFile('/etc/machine-id', 'utf8')).trim()) !== execution.coordinationHostId) throw new Error('Actions workers must use the explicitly enrolled shared coordination host');
      if(this.rescueInvocation){
        this.rescueIdentity=await verifyRescueInvocation(this,grant,this.rescueInvocation);
        this.actionIdentity=null;this.publicDispatch=null;this.executionContext={kind:'rescue',action:this.rescueIdentity};
      }else{
      if (execution.identityMode === 'local-gh') {
        this.actionIdentity = await verifyActionRun(this.github, execution, { runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT });
        if (!this.reportedLocalIdentity) {
          console.error(JSON.stringify({kind:'local-gh-operator',operatorId:this.actionIdentity.operatorId,runId:this.actionIdentity.runId,runAttempt:this.actionIdentity.runAttempt,jobStatusQueried:false}));
          this.reportedLocalIdentity=true;
        }
      } else {
        const job = await currentActionJob(this.github, execution, env);
        this.actionIdentity = await verifyActionRun(this.github, execution, { runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, jobId: job.id });
      }
      this.publicDispatch = { kind: 'action-stage', grantHash: dispatchGrantIdentity(grant) };
      }
    } else if (env.GITHUB_REPOSITORY) {
      if (!grant.policy.repositories[env.GITHUB_REPOSITORY] || !['workflow_dispatch', 'schedule'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Untrusted GitHub entry event');
      const run = await this.github.api(`${repoPath(env.GITHUB_REPOSITORY)}/actions/runs/${env.GITHUB_RUN_ID}`);
      if (run.event !== env.GITHUB_EVENT_NAME || run.repository?.full_name !== env.GITHUB_REPOSITORY || run.head_sha !== env.GITHUB_SHA || !this.config.allowedActors?.includes(run.actor?.login) || !this.config.allowedActors?.includes(run.triggering_actor?.login) || !this.config.allowedWorkflowPaths?.includes(run.path)) throw new Error('Workflow actor, revision or path is not enrolled');
      const caller = await this.github.api(`${repoPath(env.GITHUB_REPOSITORY)}/contents/${run.path}?ref=${run.head_sha}`);
      if (!grant.policy.repositories[env.GITHUB_REPOSITORY].callerWorkflowBlob || caller.sha !== grant.policy.repositories[env.GITHUB_REPOSITORY].callerWorkflowBlob) throw new Error('Caller workflow differs from the approved immutable Core entrypoint');
      const jobs = await this.github.list(`${repoPath(env.GITHUB_REPOSITORY)}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${run.run_attempt}/jobs`, 'jobs');
      const ids = grant.policy.repositories[env.GITHUB_REPOSITORY].runnerIds;
      const job = jobs.find(j => j.status === 'in_progress' && j.runner_name === this.config.runnerId && ids?.includes(j.runner_id));
      if (!job && jobs.some(j => ['queued', 'waiting', 'pending'].includes(j.status) && !j.runner_id)) {
        // GitHub may expose a running job as unassigned briefly. This grants
        // nothing: watch waits, then rereads the complete signed authority and
        // actual job identity before any Agent or write can execute.
        throw Object.assign(new Error('Awaiting GitHub readback of the approved repository runner job'), { code: 'ACTIONS_JOB_PENDING' });
      }
      if (!job) throw new Error('Current job is not executing on the approved repository runner');
      this.executionContext = { kind: 'github-actions', repository: env.GITHUB_REPOSITORY, runId: String(env.GITHUB_RUN_ID), runAttempt: run.run_attempt, jobId: String(job.id), runnerId: job.runner_id, runnerName: job.runner_name, head: run.head_sha, workflowPath: run.path, callerWorkflowBlob: caller.sha, actor: run.actor.login, triggeringActor: run.triggering_actor.login };
    }
    if (grant.policy.publicRunner) {
      await verifyKairoOwner(this.github, this.config, grant.policy, grant.actor);
      const entries = await readBindings(this.config, this.transport?{...grant.policy,...this.transport.notifications}:grant.policy);
      this.publicBindings = entries;
      for (const [repository, entry] of Object.entries(entries)) {
        const live = await this.github.repository(repository);
        if (live.private || live.owner?.type !== 'User' || String(live.owner.id) !== this.config.kairoOwnerGitHubUserId || String(live.id) !== entry.binding.repositoryId) throw new Error('Public repository is not owned by the anchored Kairo Owner');
        const file = await this.github.api(`${repoPath(repository)}/contents/${entry.binding.workflowPath}?ref=${encodeURIComponent(live.default_branch)}`);
        if (file.sha !== entry.binding.workflowBlob) throw new Error('Public workflow pin changed');
      }
      if (this.publicDispatch?.kind === 'action-stage') {
        if (grant.policy.executionMode !== 'actions-v1' || !this.actionIdentity) throw new Error('Unverified Actions execution context');
        this.executionContext = { kind: 'public-runner-dispatch', kairoOwnerGitHubUserId: this.config.kairoOwnerGitHubUserId, runnerName: this.config.runnerId, rootId: grant.policy.publicRunner.rootId, action: this.actionIdentity };
      } else if (this.publicDispatch) {
        if (env.GITHUB_REPOSITORY || this.publicDispatch.grantHash !== dispatchGrantIdentity(grant)) throw new Error('Invalid public dispatch execution context');
        const dispatches = [];
        for (const [repository, entry] of Object.entries(entries)) {
          const p = await verifyOrigin(this.github, entry, this.publicDispatch.envelopes?.[repository]);
          dispatches.push({ repository, bindingId: p.bindingId, runId: p.runId, nonce: p.nonce });
        }
        this.executionContext = { kind: 'public-runner-dispatch', kairoOwnerGitHubUserId: this.config.kairoOwnerGitHubUserId, runnerName: this.config.runnerId, rootId: grant.policy.publicRunner.rootId, dispatches };
      }
    }
    if(this.coreUpgrade)this.executionContext.coreUpgrade=this.coreUpgrade;
    if(this.runtimeHardening)this.executionContext.runtimeHardening=this.runtimeHardening;
    if(this.coreUpgrade?.issueScopeSource==='github-issue') {
      if(bundle.requirementRevision || bundle.assigneeOrderRevision || bundle.websiteRevision)throw Error('Live Issue scope cannot overlay a legacy signed requirement migration');
      await loadIssueScopes(this,grant);
    }
    return grant;
  }
  async observe(grant, state) {
    const work = () => this.github.readObservation ? this.github.readObservation(() => this.observeFresh(grant, state)) : this.observeFresh(grant, state);
    return this.github.measure ? this.github.measure('observe', work) : work();
  }
  ownerFinalization(grant, state) {
    return this.dynamicUnit && grant.policy.controlMode === 'owner-project' && grant.manifest.issues.length === 1 && grant.manifest.issues.every(issue => {
      const policy = grant.policy.repositories[issue.repository];
      return policy.ciMode === 'github-repository' && policy.deployment?.mode === 'not-applicable' && state.issues?.[issue.id]?.merge?.verified === true;
    });
  }
  async observeFresh(grant, state) {
    const fresh = await this.grant();
    if (digest(fresh.manifest) !== digest(grant.manifest) || digest(fresh.policy) !== digest(grant.policy)) throw new Error('Authority changed; new Freeze requires revalidation');
    if (grant.policy.executionMode === 'actions-v1' && grant.policy.controlMode !== 'owner-project') {
      const receipts = state.actionReceipts || [];
      requireDistinctActionRuns(receipts.map(r => r.action));
      await mapReads(receipts, async receipt => {
        const current = receipt.action.runId === this.actionIdentity?.runId;
        const actual = await verifyActionRun(this.github, this.actionExecutionPolicy(grant), {
          runId: receipt.action.runId, attempt: receipt.action.runAttempt, jobId: receipt.action.jobId,
        }, { completed: !current });
        if (actual.identityHash !== receipt.action.identityHash || receipt.transition.operation !== receipt.operation) throw new Error('Stored stage receipt no longer matches provider provenance');
      });
    }
    const issues = {}, repositories = {}, finalizing = this.ownerFinalization(grant, state);
    for (const name of new Set(grant.manifest.issues.map(i => i.repository))) {
      const repository = await this.github.repository(name);
      if (!repository.private) {
        const b = this.publicBindings?.[name]?.binding;
        if (!this.publicDispatch || this.executionContext.kind !== 'public-runner-dispatch' || !b || String(repository.id) !== b.repositoryId || String(repository.owner?.id) !== b.ownerId) throw new Error(`Public subscription execution blocked: ${name}`);
      }
      const policy = grant.policy.repositories[name];
      if (!policy || policy.ciMode !== 'github-repository' && (!Array.isArray(policy.trustedCheckAppIds) || !policy.trustedCheckAppIds.length)) throw new Error('Required trusted CI app IDs missing');
      if (repository.private) await this.github.verifyRunner(name, policy.runnerIds, this.config.runnerId);
      if (policy.ciMode === 'owner-policy') validateWorkflowPins(policy);
      // A verified merge has already passed GitHub's repository rules. Closure
      // does not need the current default head, checks or branch protection.
      const protection = finalizing ? {head:null,requiredChecks:[]} : await this.github.protections(name, policy.baseBranch, policy.ciMode);
      repositories[name] = { repository, protection };
      // Dynamic work has a fixed signed Issue set. Check the original Issue
      // directly below; the repository's filtered discovery index is not a gate.
      if (!this.dynamicUnit) {
        const members = await this.github.list(`${repoPath(name)}/issues?state=all&labels=scope${policy.milestoneNumber ? `&milestone=${policy.milestoneNumber}` : ''}`);
        const actual = members.filter(i => !i.pull_request).map(i => i.node_id).sort();
        const expected = grant.manifest.issues.filter(i => i.repository === name).map(i => i.id).sort();
        if (canonical(actual) !== canonical(expected)) {
          console.error(JSON.stringify({kind:'scope-membership-mismatch',repository:name,expected,actual}));
          throw new Error(`Scope membership changed: ${name}`);
        }
      }
    }
    for (const issue of grant.manifest.issues) {
      const stored = structuredClone(state.issues?.[issue.id] || {});
      const remote = await this.github.issue(issue);
      if (this.dynamicUnit && (remote.node_id !== issue.id || remote.number !== issue.number || remote.pull_request || !remote.labels.some(l => l.name === 'scope'))) {
        console.error(JSON.stringify({kind:'scope-issue-mismatch',repository:issue.repository,number:issue.number,expectedId:issue.id,actualId:remote.node_id,labels:remote.labels.map(l=>l.name)}));
        throw Object.assign(new Error('Original Scope Issue identity or scope label differs'),{code:'SCOPE_ISSUE_CHANGED'});
      }
      if (!repositories[issue.repository].repository.private && (remote.user?.type !== 'User' || String(remote.user?.id) !== this.config.kairoOwnerGitHubUserId)) throw new Error('Public Scope Issue must be created by the bound owner');
      const dependencies = grant.policy.controlMode === 'owner-project' && stored.merge?.verified ? [] : (await this.github.dependencies(issue)).map(i => i.node_id).sort();
      if (this.dynamicUnit && this.dynamicObservation && canonical(dependencies) !== canonical([...this.dynamicObservation.dependencies].sort())) throw Object.assign(new Error('Native dependencies changed during observation; re-evaluate before execution'), { code: 'DEPENDENCY_CHANGED' });
      if (!this.dynamicUnit && canonical(dependencies) !== canonical([...issue.dependencies].sort())) throw new Error(`Native dependencies changed: ${issue.id}`);
      const allowedBodies = grant.policy.issueScopeSource==='github-issue'?[issue.scopeHash]:[issue.scopeHash, stored.shape?.publication?.bodyHash];
      // A durable publication intent lets an interrupted body/label write be reconciled.
      if (grant.policy.issueScopeSource!=='github-issue' && state.pending?.issueId === issue.id && state.pending.operation === 'publish-shape') allowedBodies.push(stored.shape?.bodyHash);
      if (!allowedBodies.includes(digest(remote.body || ''))) throw Object.assign(new Error(`Issue requirements changed: ${issue.id}`),{code:'ISSUE_SCOPE_CHANGED'});
      const { repository, protection } = repositories[issue.repository];
      const live = { ...stored, id: remote.node_id, number: remote.number, repository: issue.repository, scopeHash: issue.scopeHash, dependencies: issue.dependencies, visibility: repository.visibility, bodyHash: digest(remote.body || ''), labels: remote.labels.map(l => l.name), state: remote.state, defaultHead: protection.head, requiredChecks: protection.requiredChecks, repairs: stored.repairs || 0, sameRootCauseFailures: stored.sameRootCauseFailures || 0 };
      if (!repository.private) { live.runnerBinding = this.publicBindings[issue.repository].binding; live.creatorGitHubUserId = String(remote.user.id); }
      if (protection.inspection) live.protectionInspection = protection.inspection;
      if (stored.prNumber) {
        const pr = await this.github.pull(issue.repository, stored.prNumber);
        // Git objects are immutable. Reuse the accepted tree/base only after
        // matching the fresh PR against the exact verified merge receipt.
        if (finalizing && (!pr.merged || !pr.merged_at || pr.node_id !== stored.merge.prId || pr.head.sha !== stored.merge.head || pr.merge_commit_sha !== stored.merge.commit)) throw Error('Merged PR differs from the verified finalization receipt');
        const commit = finalizing ? {tree:{sha:stored.candidate.tree},parents:[{sha:stored.candidate.base}]} : await this.github.api(`${repoPath(issue.repository)}/git/commits/${pr.head.sha}`);
        live.pr = { id: pr.node_id, repository: pr.head.repo?.full_name, head: pr.head.sha, tree: commit.tree.sha, base: commit.parents?.length === 1 ? commit.parents[0].sha : null, baseBranch: pr.base.ref, branch: pr.head.ref, state: pr.state, mergeState: pr.mergeable_state || 'unknown', protectionSatisfied: !pr.draft && pr.mergeable === true && pr.mergeable_state === 'clean', mergePermission: repository.permissions?.push === true };
        if (pr.merged) live.pr.mergedAt = pr.merged_at;
        const ciPolicy = grant.policy.repositories[issue.repository];
        const workflowPins = ciPolicy.ciMode === 'owner-policy' ? ciPolicy.requiredWorkflows : undefined;
        live.checks = finalizing ? [] : await this.github.checks(issue.repository, pr.head.sha, ciPolicy.trustedCheckAppIds, workflowPins);
        const paused = stored.blocked;
        if (grant.policy.controlMode === 'owner-project' && ciPolicy.ciMode === 'github-repository' && paused?.resumeOn === 'ci-change' &&
            paused.reviewHead === live.pr.head && paused.candidateHash === digest(stored.candidate) && paused.checksHash !== digest(live.checks)) live.blocked = null;
        if (pr.merged) {
          const receipt = stored.merge || (state.pending?.operation === 'merge' && state.pending.issueId === issue.id ? { decisionId: state.pending.decisionId, policyHash: digest(grant.policy) } : null);
          if (!receipt) throw new Error('Merged PR lacks durable pre-merge authorization');
          const expectedHead = stored.merge?.head || state.pending?.artifacts?.head;
          if (pr.head.sha !== expectedHead || pr.head.sha !== stored.review?.artifactIdentities?.head) throw new Error('Merged head differs from authorized and reviewed head');
          const presentOnDefault = finalizing || pr.merge_commit_sha === protection.head || ['ahead', 'identical'].includes((await this.github.api(`${repoPath(issue.repository)}/compare/${pr.merge_commit_sha}...${protection.head}`)).status);
          live.merge = { ...receipt, prId: pr.node_id, head: pr.head.sha, commit: pr.merge_commit_sha, verified: Boolean(pr.merged_at) && presentOnDefault };
          const finals = grant.policy.repositories[issue.repository].finalProofs;
          if (finals?.length) live.finalProofs = (await this.github.checks(issue.repository, pr.merge_commit_sha, ciPolicy.trustedCheckAppIds, workflowPins)).map(c => ({ name: c.name, id: c.id, commit: c.head, verified: c.trusted && (!workflowPins || c.provenanceVerified === true) && c.status === 'completed' && c.conclusion === 'success' }));
        }
        if (remote.state === 'closed' && live.merge) live.closure = { id: `${remote.node_id}:${remote.closed_at}`, mergeCommit: live.merge.commit, verified: remote.state_reason === 'completed' && Number.isFinite(Date.parse(remote.closed_at)) && Date.parse(remote.closed_at) >= Date.parse(pr.merged_at) && (grant.policy.executionMode !== 'actions-v1' || stored.closeReceipt?.closedAt === remote.closed_at && stored.closeReceipt?.mergeCommit === live.merge.commit) };
      }
      if (grant.policy.executionMode === 'actions-v1') {
        const deployment = validateDeploymentPolicy(grant.policy.repositories[issue.repository].deployment);
        if (deployment.mode === 'not-applicable') live.deploymentBaseline = { mode: 'not-applicable', reason: deployment.reason, policyHash: digest(deployment) };
        else {
          const stream = await new Store(this.config.stateDirectory, `deployment-stream:${issue.repository}:${deployment.environment}:${deployment.stream}`).read();
          const expected = stream.baseline || deployment.baseline;
          if (expected) {
            live.deploymentBaselineExpected = { repository: issue.repository, ...expected };
            const streamDeployments = await this.github.list(`${repoPath(issue.repository)}/deployments?environment=${encodeURIComponent(deployment.environment)}`);
            const latest = streamDeployments.find(d => d.environment === deployment.environment && d.payload?.stream === deployment.stream);
            live.deploymentBaseline = latest && String(latest.id) === String(expected.deploymentId)
              ? await readDeploymentProof(this.github, issue.repository, deployment, expected)
              : { status: 'unknown', code: 'UNRECONCILED_DEPLOYMENT_BASELINE' };
          } else if (deployment.bootstrap?.issueId === issue.id && deployment.bootstrap.repositoryId === grant.policy.repositories[issue.repository].repositoryId) {
            const rows = await this.github.list(`${repoPath(issue.repository)}/deployments?environment=${encodeURIComponent(deployment.environment)}`);
            live.deploymentBaseline = rows.length ? {status:'unknown',code:'BOOTSTRAP_ENVIRONMENT_NOT_EMPTY'} : {
              status:'bootstrap-empty',repository:issue.repository,repositoryId:deployment.bootstrap.repositoryId,
              issueId:issue.id,authorizationId:deployment.bootstrap.authorizationId,environment:deployment.environment,
              stream:deployment.stream,policyHash:digest(deployment),completeList:true,deploymentCount:0,observedAt:new Date().toISOString(),
            };
          } else live.deploymentBaseline = { status: 'unknown', code: 'DEPLOYMENT_BASELINE_MISSING' };
        }
        if (live.merge && issueDeploymentDisposition(grant.policy.repositories[issue.repository],issue)!=='source-only') live.deploymentObservation = await observeMergedDeployment(this.github, issue.repository, deployment, issue, live.merge.commit, grant.policy.grantId);
        if (stored.recoveryActive) {
          const rows = await this.github.list(`${repoPath(issue.repository)}/deployments?environment=${encodeURIComponent(deployment.environment)}`);
          const latest = rows.find(d => d.environment === deployment.environment && d.payload?.stream === deployment.stream);
          if (String(latest?.id) === String(stored.recoveryActive.deployment.deploymentId))
            live.repairBaseline = await readDeploymentProof(this.github, issue.repository, deployment, stored.recoveryActive.deployment);
        }
        const failure = stored.deploymentFailure || stored.recoveryActive?.failure;
        const repairSource = this.config.repairGrantSources?.[issue.id];
        if (failure && repairSource) {
          if (repairSource.repository !== this.config.grantSource.repository) throw new Error('Repair authority must remain in the trusted private authority repository');
          try {
            const repairGrant = verifyGrant(await this.github.grant(repairSource), await readFile(this.config.publicKeyPath, 'utf8'));
            const permission = requireRepairAuthorization(repairGrant, issue, failure, Date.now(), grant);
            live.repairAuthorization = { verified: true, recordId: repairGrant.recordId, grantId: repairGrant.policy.grantId,
              policyHash: digest(repairGrant.policy), failureProofHash: failure.failureProofHash, issueId: issue.id,
              maxCycles: permission.maxCycles, validFrom: repairGrant.policy.validFrom, expiresAt: repairGrant.policy.expiresAt };
          } catch (error) {
            if (error.status !== 404 && error.code !== 'REPAIR_AUTHORITY_MISSING') throw error;
            live.repairAuthorization = null;
          }
        }
      }
      issues[issue.id] = live;
    }
    const scratch = join(this.config.stateDirectory, 'health');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    // Subscription availability is required by Core. Share only this local
    // health probe within an invocation; actual agent execution checks again.
    const healthOwner = this.agentHealthOwner || this;
    healthOwner.agentHealth ||= this.agent.login(scratch, scratch).catch(error => { healthOwner.agentHealth = null; throw error; });
    await healthOwner.agentHealth;
    return { manifestHash: digest(grant.manifest), policyHash: digest(grant.policy), approval: fresh.approval, runtime: { trusted: true, isolated: true, coreDigest: grant.policy.coreDigest, installedCoreDigest: this.installedCoreDigest || grant.policy.coreDigest, ...(this.coreUpgrade ? {coreUpgrade:this.coreUpgrade} : {}), runnerId: this.config.runnerId, agent: 'codex-chatgpt', authenticated: true, ...(this.actionIdentity ? { actionStage: this.actionIdentity } : {}), ...(this.publicDispatch ? { publicDispatch: this.executionContext } : {}) }, issues };
  }
  workspace(grant, issue, stored, shape = false) {
    const path = join(this.config.stateDirectory, 'workspaces', digest(grant.manifest.id), issueKey(issue), shape ? grant.policy.executionMode === 'actions-v1' ? `shape-${stored.repairs || 0}` : 'shape' : `attempt-${stored.repairs || 0}`);
    return this.workspaceFactory(path, issue);
  }
  async save(store, state) { return store.transaction(state.revision, () => state); }
  async execute(grant, state, snapshot, decision, store) {
    if(this.rescueInvocation||this.executionContext?.kind==='rescue')throw Error('Rescue cannot execute product lifecycle transitions');
    const issue = grant.manifest.issues.find(i => i.id === decision.issueId);
    const live = snapshot.issues[issue.id];
    const stored = state.issues[issue.id] ||= { repairs: 0, sameRootCauseFailures: 0 };
    const operation = decision.operation;
    const policy = grant.policy.repositories[issue.repository];
    if (stored.blocked?.resumeOn === 'ci-change' && !live.blocked) delete stored.blocked;
    const role = { shape: 'shape', 'validate-shape': 'shape-validator', 'diagnose-shape': 'shape-diagnosis', deliver: 'deliver', accept: 'accept', 'shaper-review': 'shaper-review', 'diagnose-deployment': 'deployment-diagnosis' }[operation];
    if (role) {
      const workspace = this.workspace(grant, issue, stored, ['shape', 'shape-validator'].includes(role));
      let base = stored.shapeConcern?.attempt?.base || stored.candidate?.base || (role==='deliver'?continuedDeliveryBase(grant.manifest,snapshot,issue,live):null) || live.defaultHead;
      if (role === 'shape-validator') {
        // Validate the same repository snapshot the Shaper investigated. A
        // concurrent Issue may have advanced main without changing this Shape.
        base = stored.shape.base || await workspace.fetchedBase();
        console.error(JSON.stringify({kind:'shape-validation-base',issueId:issue.id,base,currentDefault:live.defaultHead,legacy:!stored.shape.base}));
      }
      let repairRestoration=null;
      const repairSeed=stored.repairSeed?.targetAttempt===stored.repairs?stored.repairSeed:
        !(stored.repairs||0)&&!stored.candidate?this.priorImplementation:null;
      if(role==='deliver'&&repairSeed){
        if(repairSeed.sourceUnitId&&!/^dynamic:[a-f0-9]{64}$/.test(repairSeed.sourceUnitId))throw Error('Invalid prior Scope workspace identity');
        const sourceGrant=repairSeed.sourceUnitId?{...grant,manifest:{...grant.manifest,id:repairSeed.sourceUnitId}}:grant;
        const source=this.workspace(sourceGrant,issue,{repairs:repairSeed.sourceAttempt});
        repairRestoration=await workspace.restoreRepair(source,repairSeed,base);
        console.error(JSON.stringify({kind:'repair-workspace-restored',issueId:issue.id,sourceUnitId:repairSeed.sourceUnitId||null,sourceAttempt:repairSeed.sourceAttempt,targetAttempt:stored.repairs,...repairRestoration}));
      }else await workspace.prepare(base);
      const obligations = stored.shape ? candidateContract(stored.shape.body) : null;
      const inspect = () => role === 'shape-diagnosis' ? workspace.captureAttempt(base) : workspace.capture(base,true,obligations);
      const before = ['accept', 'shaper-review', 'shape-diagnosis', 'deployment-diagnosis'].includes(role) ? await inspect() : null;
      // This is an input observation. Required outputs may still need to be
      // generated by Deliver; the full obligation inventory is checked below
      // after the Agent returns, before any independent Acceptance.
      const repairView=repairRestoration&&!repairRestoration.conflicts.length?await workspace.capture(base,true):null;
      const repositoryObservation = await workspace.provenance(base, before?.tree||repairView?.tree);
      if (before && digest(before) !== digest(role === 'shape-diagnosis' ? stored.shapeConcern.attempt : stored.candidate)) throw new Error('Candidate changed before reviewer');
      const skillSelection = selectSkill(grant.policy, issue.repository, role);
      const customization = skillSelection.customization;
      const context = { skillSelection, effectiveRepairContract: grant.policy.deliveryRepairMode === 'until-conformant' ? { authority: 'owner-signed autonomy policy', precedence: 'Overrides count-based Deliver repair stops in the supplied Proposal only. Correct Shape plus independently confirmed implementation defect must continue repair regardless of count; independently evidenced incorrect Shape restores Scope and stops the cohort. All other authority, evidence and safety gates remain mandatory.' } : null, issue, cohort: grant.manifest, proposal: grant.proposal, policy: grant.policy, shape: stored.shape?.body, shapeEvidence: stored.shape, shapeConcern: stored.shapeConcern, deliveryConcern: stored.deliveryConcern, acceptance: stored.accept, candidate: role === 'shape-diagnosis' ? stored.shapeConcern.attempt : stored.candidate, diff: before ? await workspace.diff(base) : null, pr: live.pr, checks: live.checks, previousFindings: stored.repairFindings || [], binding: binding(grant.manifest, grant.policy) };
      context.schedulingContract = grant.manifest.dynamicParent ? { authority: 'owner-signed dynamic scheduling grant', mode: 'native-dependencies', unit: grant.manifest.id, observation: snapshot.dynamicDependencies, rule: 'This grant supersedes frozen total-order/global All-Shaped requirements only. Core checks live native dependencies before each stage/write. This Issue has its own Shape and delivery gates. Do not invent ordering or alter dependencies.' } : null;
      if(grant.policy.issueScopeSource==='github-issue')context.requirementsSource={kind:'github-issue',scopeHash:issue.scopeHash,
        rule:'The current Issue scopeBody is the requirements SSOT for this execution. Earlier Proposal text is background and does not override explicit Issue corrections. Stay within granted operational permissions. Historical Shape, candidate and review evidence belongs only to its original cycle.'};
      context.repositoryObservation = repositoryObservation;
      if(repairRestoration){
        context.repairSource={...repairSeed,restoration:repairRestoration};
        context.diff=await workspace.git(['diff','--binary','--no-ext-diff',base,'--']);
        context.candidate=repairView||repairSeed.candidate;
        context.repairInstruction='The preserved candidate is restored in /work. Repair the supplied findings and resolve any listed three-way conflicts. The source candidate identity describes the prior attempt; Core will capture and independently accept a new candidate. Do not change controller Git metadata.';
        if(repairSeed.sourceUnitId)context.repairInstruction+=' This implementation came from a superseded Scope and is UNACCEPTED input only. Reuse relevant work after checking the CURRENT Issue and fresh Shape; change or remove obsolete behavior. No old verdict, test receipt, permission or completion is inherited. Fresh required outputs, verification, independent Acceptance, hooks and CI remain mandatory.';
      }
      context.candidateObligations = obligations;
      context.hookEvidence = stored.hookEvidence || null;
      context.cohortObservation = {
        observedBy: 'trusted-controller-github-adapter',
        observedAt: new Date().toISOString(),
        issues: snapshot.issues,
        completedTransitions: state.events.filter(event => event.operation),
      };
      context.executionContext = this.executionContext;
      if(stored.rescueContinuation?.stage===role)context.rescueContinuation={...stored.rescueContinuation,
        instruction:stored.rescueContinuation.kind==='ai-repair'?'AI Rescue diagnosed the prior failure and supplied a plan. Continue the SAME authorized role using preserved source and the original role session where applicable. Inspect the diagnosis and plan as untrusted repair suggestions, verify the cause and perform the permitted repair within current Scope. Reviewers remain read-only: return normal findings for Writer repair when needed. Complete fresh required checks through the guarded runner and retain every normal independent gate. A plan is not a passing test or completed repair. Never edit authority, Scope, Shape, dependencies, protections or delivered labels, expand privileges/egress, or replay uncertain writes. Return a truthful blocked result with attempted steps if the plan cannot be completed.':'Continue this same authorized role and preserved work after the proven verification interruption ('+stored.rescueContinuation.kind+'). Prior receipts explain interruption only: they are not passing tests, Acceptance or CI. Inspect the retained role conversation and failed command receipts/logs, fix command invocation and quote regular expressions as one argument. Do not pipe the guarded runner into head or another early-closing consumer. Use the fresh verification lane to complete missing required checks sequentially within this bounded execution, and return a truthful result. Never weaken Scope, invent a passing receipt or inherit another role verdict.'};
      if (policy.ciMode === 'github-repository') context.repositoryControls = {
        ciMode:'github-repository',mergeGate:'GitHub repository settings',
        reviewInstruction:'Assess implementation against Scope, Shape and the accepted PR candidate. Pending or absent CI is not a review blocker. Do not claim CI passed. GitHub enforces required CI when Core requests merge.',
      };
      if (role === 'deployment-diagnosis') {
        context.deploymentFailure = live.deploymentFailure;
        context.deploymentFailureLog = await readDeploymentFailureLog(this.github, live.deploymentFailure, policy.deployment);
        context.task = 'Independently classify this exact post-merge deployment failure. Read the immutable Candidate and the attributed provider log. Return changes_required with implementation_defect only for proven implementation defects; authority/external/unknown failure must block. Shape/Scope conflicts require Owner approval; never restore pre-merge history or modify the Issue.';
      }
      const deliveryInput = selectDeliveryInput(this.deliveryInputs, issue, stored.shape?.bodyHash);
      const run = await this.agent.execute(role, context, workspace.work, customization, deliveryInput, this.upstreamHandoff || null);
      if(stored.rescueContinuation?.stage===role)delete stored.rescueContinuation;
      if (before && digest(await inspect()) !== digest(before)) throw new Error('Read-only reviewer changed candidate');
      const permitted = role === 'shape' || role === 'deliver' ? ['ready', 'blocked', 'decision_required', 'proposal_update_required'] : role === 'accept' ? ['accepted', 'changes_required', 'blocked', 'decision_required', 'proposal_update_required'] : ['approved', 'changes_required', 'blocked', 'decision_required', 'proposal_update_required'];
      if (role === 'deliver') permitted.push('changes_required');
      if (!permitted.includes(run.result.outcome)) throw new Error('Invalid outcome for stage');
      run.reportedOutcome = run.result.outcome;
      run.reportedFailureClass = run.result.failureClass;
      const normalized = reviewOutcome(run.result);
      if (role !== 'deliver') run.result.outcome = normalized;
      stored.lastRootCause = run.result.rootCause;
      if (role === 'deliver' && run.result.failureClass === 'shape_defect') {
        const attempt = await workspace.captureAttempt(base);
        if (this.agent.checkCandidateOutput) await this.agent.checkCandidateOutput(workspace.work, attempt.paths);
        stored.shapeConcern = { ...run.result, attempt, executionId: run.executionId, evidencePath: run.evidencePath };
        state.events.push({ ...decision, completedAt: new Date().toISOString(), outcome: 'shape-diagnosis-required' });
        state.pending = null;
        return this.save(store, state);
      }
      if (role === 'deliver' && normalized === 'changes_required' && run.result.failureClass === 'implementation_defect') {
        // The independent Accept classifies the actual attempt, not Deliver's claim.
        stored.deliveryConcern = structuredClone(run.result);
        run.result = { ...run.result, outcome: 'ready', failureClass: 'none', blockingFindings: [] };
      }
      if (['blocked', 'decision_required', 'proposal_update_required'].includes(run.result.outcome)) {
        stored.blocked = { ...run.result, stage: role, executionId: run.executionId, evidencePath: run.evidencePath, policyHash: digest(grant.policy) };
        if (grant.policy.controlMode === 'owner-project' && policy.ciMode === 'github-repository' && role === 'shaper-review' && run.result.outcome === 'blocked' && run.result.failureClass === 'external_failure' &&
            (!live.checks.length || live.checks.some(c=>c.status !== 'completed'))) Object.assign(stored.blocked,{
          resumeOn:'ci-change',reviewHead:live.pr.head,candidateHash:digest(stored.candidate),checksHash:digest(live.checks),
        });
        state.events.push({ ...decision, completedAt: new Date().toISOString(), outcome: run.result.outcome });
        state.pending = null;
        return this.save(store, state);
      }
      if (role === 'shape') {
        if (!run.result.body && run.result.outcome === 'ready') throw new Error('Empty Shape contract');
        candidateContract(run.result.body);
        stored.shape = { body: run.result.body, bodyHash: digest(run.result.body), base, author: envelope(grant, issue, role, run, { scopeHash: issue.scopeHash, shapeHash: digest(run.result.body), base, tree: repositoryObservation.tree }) };
      } else if (role === 'shape-validator') stored.shape.validator = envelope(grant, issue, role, run, { scopeHash: issue.scopeHash, shapeHash: stored.shape.bodyHash });
      else if (role === 'shape-diagnosis') stored.shapeDiagnosis = envelope(grant, issue, role, run, { shapeHash: stored.shape.bodyHash, concernHash: digest(stored.shapeConcern), attemptHash: digest(stored.shapeConcern.attempt) });
      else if (role === 'deliver') {
        try {
          const beforeHooks = await workspace.capture(base, true, obligations);
          if (grant.policy.executionMode === 'actions-v1') {
            stored.candidate = beforeHooks;
            if (this.ownerIssueSession && !obligations.hooks.length) stored.hookEvidence = {...await runHooks(this.config.agent,workspace.work,[]),candidateHash:digest(stored.candidate),action:structuredClone(this.executionContext)};
          } else {
            const receipt = await runHooks(this.config.agent, workspace.work, obligations.hooks, undefined, obligations.hooks.length ? await workspace.hookRepository(base, beforeHooks) : undefined);
            stored.hookEvidence = {...receipt, beforeHash:digest(beforeHooks)};
            if (receipt.status === 'failed') throw new Error('Declared commit hook failed');
            stored.candidate = await workspace.capture(base, true, obligations);
            stored.hookEvidence.candidateHash = digest(stored.candidate);
          }
        } catch (error) {
          if (error.recoveryRequired) throw error;
          stored.candidateFailure = {reason:error.message, stage:'deliver', base, executionId:run.executionId};
          state.events.push({...decision, completedAt:new Date().toISOString(), outcome:'candidate-obligation-failed',hookEvidence:stored.hookEvidence || null,preCommitHooks:stored.preCommitHooks || null});
          state.pending = null;
          return this.save(store,state);
        }
        if (this.agent.checkCandidateOutput) await this.agent.checkCandidateOutput(workspace.work, [...stored.candidate.paths, ...stored.candidate.artifacts.map(a=>a.path)]);
        stored.delivery = envelope(grant, issue, role, run, { candidateHash: digest(stored.candidate), shapeHash: stored.shape.bodyHash });
      } else if (role === 'deployment-diagnosis') {
        stored.deploymentDiagnosis = envelope(grant, issue, role, run, { candidateHash: digest(stored.candidate), failureProofHash: live.deploymentFailure.failureProofHash });
      } else {
        const artifacts = { candidateHash: digest(stored.candidate), shapeHash: stored.shape.bodyHash, ...(role === 'accept' ? { preCommit: true } : { head: live.pr.head, prId: live.pr.id }) };
        stored[role === 'accept' ? 'accept' : 'review'] = envelope(grant, issue, role, run, artifacts);
        if (this.ownerIssueSession && role === 'accept' && run.result.outcome === 'accepted' && !stored.candidate.obligations.hooks.length)
          stored.preCommitHooks = {...await runHooks(this.config.agent,workspace.work,[]),candidateHash:digest(stored.candidate),action:structuredClone(this.executionContext)};
      }
    } else if (operation === 'publish-shape') {
      const liveScope=grant.policy.issueScopeSource==='github-issue';
      if(!liveScope)await this.github.updateIssue(issue, { body: stored.shape.body });
      await this.github.label(issue, 'shaped');
      const remote = await this.github.issue(issue);
      if (digest(remote.body) !== (liveScope?issue.scopeHash:stored.shape.bodyHash) || !remote.labels.some(l => l.name === 'shaped')) throw Object.assign(new Error('Shape publication readback failed'),{code:'ISSUE_SCOPE_CHANGED'});
      stored.shape.publication = { bodyHash: stored.shape.bodyHash, policyHash: digest(grant.policy), decisionId: decision.decisionId,...(liveScope?{scopeHash:issue.scopeHash}: {}) };
    } else if (['pre-accept-hooks', 'post-accept-hooks'].includes(operation)) {
      if (grant.policy.executionMode !== 'actions-v1') throw new Error('Separate hook stages require explicitly approved Actions execution');
      const workspace = this.workspace(grant, issue, stored), candidate = stored.candidate;
      let beforeConsistent = false;
      try { beforeConsistent = digest(await workspace.capture(candidate.base, false, candidate.obligations)) === digest(candidate); } catch { /* missing artifacts invalidate this candidate */ }
      if (!beforeConsistent) stored.candidateFailure = { reason: 'Candidate changed before the isolated hook action', stage: operation };
      else {
        const receipt = await runHooks(this.config.agent, workspace.work, candidate.obligations.hooks, undefined, candidate.obligations.hooks.length ? await workspace.hookRepository(candidate.base, candidate) : undefined);
        let consistent = false;
        try { consistent = digest(await workspace.capture(candidate.base, false, candidate.obligations)) === digest(candidate); } catch { /* hook deletion is a fresh-delivery finding */ }
        if (receipt.status === 'failed' || !consistent) stored.candidateFailure = { reason: 'Isolated hook action failed or changed Candidate; fresh delivery and acceptance required', stage: operation };
        else stored[operation === 'pre-accept-hooks' ? 'hookEvidence' : 'preCommitHooks'] = { ...receipt, candidateHash: digest(candidate), action: structuredClone(this.executionContext) };
      }
    } else if (operation === 'commit-pr') {
      const workspace = this.workspace(grant, issue, stored);
      const receipt = grant.policy.executionMode === 'actions-v1' ? stored.preCommitHooks : await runHooks(this.config.agent, workspace.work, stored.candidate.obligations.hooks, undefined, stored.candidate.obligations.hooks.length ? await workspace.hookRepository(stored.candidate.base, stored.candidate) : undefined);
      if (!receipt) throw new Error('Missing independent post-Accept Hook action');
      stored.preCommitHooks = receipt;
      let consistent = false;
      try { consistent = digest(await workspace.capture(stored.candidate.base, false, stored.candidate.obligations)) === digest(stored.candidate); } catch { /* missing artifacts invalidate acceptance */ }
      if (receipt.status === 'failed' || !consistent) {
        stored.candidateFailure = {reason:'Commit hooks failed or changed the accepted Candidate; repeat Deliver and independent Accept',stage:'commit-pr'};
        state.events.push({...decision,completedAt:new Date().toISOString(),outcome:'candidate-obligation-failed',hookEvidence:stored.hookEvidence || null,preCommitHooks:stored.preCommitHooks || null});
        state.pending = null;
        return this.save(store,state);
      }
      stored.preCommitHooks.candidateHash = digest(stored.candidate);
      const commit = await workspace.commit(stored.candidate, state.pending.startedAt);
      const branch = `${policy.branchPrefix}${issue.number}-${digest(grant.policy.issueScopeSource==='github-issue'?{candidate:stored.candidate,cycle:grant.manifest.id}:stored.candidate).slice(0, 16)}`;
      await workspace.push(commit, branch);
      let pr = await this.github.findPull(issue.repository, branch) || await this.github.createPull(issue, branch, policy.baseBranch);
      if (pr.state === 'closed' && !pr.merged && pr.head.sha === commit) {
        await this.github.api(repoPath(issue.repository) + '/pulls/' + pr.number, 'PATCH', {state:'open'});
        pr = await this.github.pull(issue.repository,pr.number);
      }
      if (pr.head.sha !== commit || pr.base.ref !== policy.baseBranch) throw new Error('Created PR does not match accepted commit');
      stored.prNumber = pr.number;
    } else if (operation === 'merge') {
      if (!live.merge) {
        const candidateWorkspace = this.workspace(grant, issue, stored);
        let unchanged = false;
        try { unchanged = digest(await candidateWorkspace.capture(stored.candidate.base, false, stored.candidate.obligations)) === digest(stored.candidate); } catch { /* missing proof cannot authorize merge */ }
        if (!unchanged) {
          stored.candidateFailure = {reason:'Candidate or required artifact changed after final review',stage:'merge'};
          state.events.push({...decision,completedAt:new Date().toISOString(),outcome:'candidate-obligation-failed'});
          state.pending = null;
          return this.save(store,state);
        }
        if (policy.mergeStrategy === 'atomic-merge') {
          const workspace = this.workspace(grant, issue, stored);
          const mergedCommit = await workspace.mergeCommit(stored.candidate, live.pr.head, state.pending.startedAt);
          state.pending.atomicCommit = mergedCommit;
          state.revision = (await this.save(store, state)).revision;
          try { await workspace.advanceBase(mergedCommit, policy.baseBranch, stored.candidate.base); }
          catch (error) {
            if (error.code !== 'BASE_LEASE_REJECTED') throw error;
            state.events.push({ ...decision, outcome: 'base-changed-before-merge' });
            state.pending = null;
            return this.save(store, state);
          }
        } else {
          try { await this.github.merge(issue.repository, stored.prNumber, live.pr.head, policy.mergeMethod); }
          catch (error) {
            if (policy.ciMode !== 'github-repository' || ![405,409,422].includes(error.status)) throw error;
            state.events.push({kind:'github-merge-rejected',issueId:issue.id,status:error.status,message:error.message,at:new Date().toISOString()});
            state.pending = null;
            state.revision = (await this.save(store,state)).revision;
            throw Object.assign(new Error('GitHub rejected merge: '+error.message),{code:'MERGE_REQUIREMENTS_PENDING'});
          }
        }
      }
      const pr = await this.github.pull(issue.repository, stored.prNumber);
      if (!pr.merged) throw Object.assign(new Error('Waiting for GitHub merge readback'), {code:'MERGE_READBACK_PENDING'});
      if (pr.head.sha !== live.pr.head || (state.pending.atomicCommit && pr.merge_commit_sha !== state.pending.atomicCommit)) throw new Error('Merge readback mismatch');
      stored.merge = { prId: pr.node_id, head: pr.head.sha, commit: pr.merge_commit_sha, verified: true, policyHash: digest(grant.policy), decisionId: decision.decisionId };
    } else if (operation === 'verify-deployment') {
      if (grant.policy.executionMode !== 'actions-v1') throw new Error('Deployment verification requires the explicit Actions contract');
      const proof = live.deploymentObservation;
      if (!proof || !['healthy', 'failed'].includes(proof.status) && proof.mode !== 'not-applicable') throw new Error('Exact merge-bound deployment proof is not available');
      stored.deploymentVerification = { proofHash: deploymentProofHash(proof), proof, action: structuredClone(this.actionIdentity) };
      if (proof.status === 'failed') stored.deploymentFailure = { ...proof, failureProofHash: deploymentProofHash(proof), previousCompletionHash: state.completion?.completionHash || null };
    } else if (operation === 'record-recovery-comment') {
      const failure = live.deploymentFailure, log = await readDeploymentFailureLog(this.github, failure, policy.deployment);
      if (!state.completion?.completionHash) throw new Error('Closed recovery requires the original verified completion certificate');
      const body = recoveryComment({ issueId: issue.id, repository: issue.repository, previousCompletionHash: state.completion.completionHash,
        previousGrantId: grant.policy.grantId, environment: failure.environment, stream: failure.stream, deploymentId: failure.deploymentId,
        version: failure.version, commit: failure.commit, prNumber: stored.prNumber, runId: failure.runId, runAttempt: failure.runAttempt,
        jobId: log.jobId, logUrl: log.logUrl, observation: 'The required deployment health/function job failed for this exact recorded version.',
        attribution: 'Provider deployment identity, merge authorization and failed pinned workflow identify this original Issue.', failureProofHash: failure.failureProofHash }, [this.github.token]);
      const intended = body + `\n<!-- kairo-recovery:${state.pending.decisionId} -->\n`;
      const comments = await this.github.list(`${repoPath(issue.repository)}/issues/${issue.number}/comments`);
      let comment = comments.find(c => c.body === intended);
      if (!comment) {
        if (state.pending.commentAttempted) throw Object.assign(new Error('Recovery comment write is ambiguous; readback required, no duplicate comment posted'), { code: 'AMBIGUOUS_WRITE' });
        state.pending.commentAttempted = true;
        state.revision = (await this.save(store, state)).revision;
        comment = await this.github.api(`${repoPath(issue.repository)}/issues/${issue.number}/comments`, 'POST', { body: intended });
      }
      const actual = await this.github.api(`${repoPath(issue.repository)}/issues/comments/${comment.id}`);
      const writers = grant.policy.actionWriterIds || [grant.policy.kairoOwnerGitHubUserId];
      if (actual.body !== intended || !writers.map(String).includes(String(actual.user?.id))) throw new Error('Recovery comment body or event-producing writer readback failed');
      stored.recoveryComment = { commentId: String(actual.id), commentHash: digest(actual.body), createdAt: actual.created_at,
        previousCompletionHash: state.completion.completionHash, previousGrantId: grant.policy.grantId, failureProofHash: failure.failureProofHash,
        commit: failure.commit, environment: failure.environment, stream: failure.stream, deploymentId: failure.deploymentId };
    } else if (operation === 'reopen-recovery') {
      if (!stored.recoveryComment) throw new Error('Recovery Reopen requires the saved and verified comment');
      let remote = await this.github.issue(issue);
      if (remote.state === 'closed') await this.github.updateIssue(issue, { state: 'open', state_reason: 'reopened' });
      remote = await this.github.issue(issue);
      const events = await this.github.list(`${repoPath(issue.repository)}/issues/${issue.number}/events`);
      const writers = grant.policy.actionWriterIds || [grant.policy.kairoOwnerGitHubUserId];
      const reopened = events.findLast(e => e.event === 'reopened' && writers.map(String).includes(String(e.actor?.id)) && Date.parse(e.created_at) >= Date.parse(stored.recoveryComment.createdAt));
      if (remote.state !== 'open' || !reopened) throw new Error('Reopen lacks actual Issue event and enrolled event-producing writer readback');
      stored.reopenedReceipt = { eventId: String(reopened.id), actorId: String(reopened.actor.id), at: reopened.created_at, commentHash: stored.recoveryComment.commentHash, action: structuredClone(this.actionIdentity) };
    } else if (operation === 'verify-recovery') {
      const source = await verifyRecoverySource(this.github, issue, stored.recoveryComment, {
        writerIds: grant.policy.actionWriterIds || [grant.policy.kairoOwnerGitHubUserId], workflow: policy.deployment.workflow,
      });
      stored.recoverySource = { ...source, log: { sha256: source.log.sha256, size: source.log.size }, action: structuredClone(this.actionIdentity) };
    } else if (operation === 'post-merge-repair') {
      if (!live.merge || !stored.deploymentDiagnosis) throw new Error('Post-merge correction needs immutable merge and independent diagnosis');
      // All external writes/readbacks precede local retirement of old evidence.
      // A lost delete response leaves the old cycle intact for reconciliation.
      const remote = await this.github.issue(issue);
      if (remote.labels.some(l => l.name === 'delivered')) await this.github.removeLabel(issue, 'delivered');
      if ((await this.github.issue(issue)).labels.some(l => l.name === 'delivered')) throw new Error('Stale delivery label removal readback failed');
      const failure = live.deploymentFailure;
      const { mergeHistory, ...oldCycle } = stored;
      stored.mergeHistory = [...(mergeHistory || []), { at: new Date().toISOString(), issue: structuredClone(oldCycle), completion: state.completion || null }];
      stored.recoveryActive = { policyHash: digest(grant.policy), issueId: issue.id, failureProofHash: failure.failureProofHash,
        failure: structuredClone(failure), repairAuthorizationHash: digest(live.repairAuthorization),
        deployment: { deploymentId: failure.deploymentId, commit: failure.commit, version: failure.version, issueId: issue.id, grantId: failure.grantId } };
      stored.repairs++;
      stored.repairFindings = stored.deploymentDiagnosis.blockingFindings;
      for (const key of ['candidate', 'delivery', 'accept', 'review', 'prNumber', 'merge', 'deploymentVerification', 'deploymentFailure', 'deploymentDiagnosis', 'closeReceipt', 'delivered', 'recoveryComment', 'reopenedReceipt', 'recoverySource', 'hookEvidence', 'preCommitHooks', 'candidateFailure']) delete stored[key];
      if (state.completion) { state.invalidatedCompletions ||= []; state.invalidatedCompletions.push({ certificate: state.completion, failureProofHash: failure.failureProofHash }); delete state.completion; }
    } else if (operation === 'close' && grant.policy.controlMode === 'owner-project' && (policy.deployment?.mode === 'not-applicable' || issueDeploymentDisposition(policy,issue)==='source-only')) {
      let remote = await this.github.issue(issue);
      if (remote.state !== 'closed') {
        if (stored.closeReceipt) throw Error('Issue was reopened after finalization began');
        await this.github.updateIssue(issue, {state:'closed',state_reason:'completed'});
        remote = await this.github.issue(issue);
      }
      if (remote.state !== 'closed' || remote.state_reason !== 'completed' || !remote.closed_at) throw Error('Closure readback failed');
      if (stored.closeReceipt && stored.closeReceipt.closedAt !== remote.closed_at) throw Error('Closure changed during finalization');
      stored.closeReceipt ||= {closedAt:remote.closed_at,mergeCommit:live.merge.commit,policyHash:digest(grant.policy),decisionId:decision.decisionId,action:structuredClone(this.actionIdentity)};
      state.revision = (await this.save(store,state)).revision;
      if (!remote.labels.some(l=>l.name==='delivered')) await this.github.label(issue,'delivered');
      remote = await this.github.issue(issue);
      if (remote.state !== 'closed' || remote.state_reason !== 'completed' || remote.closed_at !== stored.closeReceipt.closedAt || !(Date.parse(remote.closed_at) >= Date.parse(live.pr.mergedAt)) || !remote.labels.some(l=>l.name==='delivered')) throw Error('Finalization readback failed');
      stored.delivered = {policyHash:digest(grant.policy),decisionId:decision.decisionId,mergeCommit:live.merge.commit};
      // Completion consumes this actual write readback, without another full
      // observation of the same immutable merge and freshly written Issue.
      if (remote.node_id !== issue.id || remote.number !== issue.number) throw Error('Finalization Issue identity changed');
      if (this.ownerFinalization(grant,state)) this.finalizationObservation = {...snapshot,issues:{...snapshot.issues,[issue.id]:{
        ...live,state:remote.state,bodyHash:digest(remote.body || ''),labels:remote.labels.map(l=>l.name),closeReceipt:structuredClone(stored.closeReceipt),delivered:structuredClone(stored.delivered),
        closure:{id:`${remote.node_id}:${remote.closed_at}`,mergeCommit:live.merge.commit,verified:true},
      }}};
    } else if (operation === 'close') {
      await this.github.updateIssue(issue, { state: 'closed', state_reason: 'completed' });
      if (grant.policy.executionMode === 'actions-v1') {
        const remote = await this.github.issue(issue);
        if (remote.state !== 'closed' || remote.state_reason !== 'completed') throw new Error('Closure readback failed');
        stored.closeReceipt = { closedAt: remote.closed_at, mergeCommit: live.merge.commit, policyHash: digest(grant.policy), decisionId: decision.decisionId, action: structuredClone(this.actionIdentity) };
      }
    } else if (operation === 'mark-delivered') {
      await this.github.label(issue, 'delivered');
      stored.delivered = { policyHash: digest(grant.policy), decisionId: decision.decisionId, mergeCommit: live.merge.commit };
    } else if (operation === 'invalidate-shape') {
      if (live.merge || stored.mergeHistory?.length) throw new Error('Cannot silently undo an already merged delivery');
      if (stored.prNumber) {
        const pr = await this.github.pull(issue.repository, stored.prNumber);
        if (pr.merged) throw new Error('Cannot invalidate Shape after merge without explicit recovery');
        if (pr.state === 'open') await this.github.api(`${repoPath(issue.repository)}/pulls/${stored.prNumber}`, 'PATCH', { state: 'closed' });
      }
      await this.github.updateIssue(issue, { ...(grant.policy.issueScopeSource==='github-issue'?{}:{body:issue.scopeBody}), state: 'open' });
      await this.github.removeLabel(issue, 'shaped');
      await this.github.removeLabel(issue, 'delivered');
      const remote = await this.github.issue(issue);
      if (digest(remote.body) !== issue.scopeHash || remote.state !== 'open' || remote.labels.some(l => ['shaped', 'delivered'].includes(l.name))) throw new Error('Scope restoration readback failed');
      const affected = grant.manifest.issues.slice(grant.manifest.issues.findIndex(i => i.id === issue.id)).map(i => i.id);
      state.invalidations ||= [];
      state.invalidations.push({ decision, at: new Date().toISOString(), affected, historicalEvidence: structuredClone(state.issues) });
      for (const id of affected) if (state.issues[id]) state.issues[id].evidenceInvalidatedBy = decision.decisionId;
      stored.scopeReset = { decisionId: decision.decisionId, scopeHash: issue.scopeHash, reason: 'independently-confirmed-shape-defect' };
      for (const key of ['shape', 'candidate', 'delivery', 'accept', 'review', 'shapeConcern', 'shapeDiagnosis']) delete stored[key];
      if (grant.policy.executionMode === 'actions-v1') {
        stored.shapeRestorations ||= []; stored.shapeRestorations.push(stored.scopeReset);
        delete stored.scopeReset; stored.repairs++;
        for (const key of ['prNumber', 'hookEvidence', 'preCommitHooks', 'candidateFailure', 'deliveryConcern']) delete stored[key];
      }
    } else if (operation === 'repair') {
      // Preserve immutable input BEFORE invalidating old verdicts or advancing
      // the attempt. If publication outcome is unknown, existing safeguards stop.
      if(decision.artifacts.stage!=='shape'){
        const source=this.workspace(grant,issue,stored);
        let seed;
        if(stored.candidate) seed=await source.snapshotCandidate(stored.candidate);
        else if(stored.candidateFailure?.base||stored.shapeConcern?.attempt?.base) seed=await source.snapshotRepair(stored.candidateFailure?.base||stored.shapeConcern.attempt.base,candidateContract(stored.shape.body));
        else throw new Error('Cannot repair without preserved implementation input');
        stored.repairSeed={...seed,sourceAttempt:stored.repairs||0,targetAttempt:(stored.repairs||0)+1};
        state.revision=(await this.save(store,state)).revision;
      }
      const finding = decision.artifacts.stage === 'shape' ? stored.shape.validator : stored.review || stored.accept;
      stored.repairFindings = decision.artifacts.cause === 'candidate-obligation' ? [stored.candidateFailure.reason, JSON.stringify(stored.hookEvidence?.output || stored.preCommitHooks?.output || {})] : decision.artifacts.cause === 'diagnosed-implementation' ? ['Independent diagnosis confirmed the Shape contract. Correct the implementation against the unchanged contract.', ...(stored.shapeDiagnosis?.evidenceReferences || [])] : decision.artifacts.cause === 'ci' ? live.checks.filter(c => c.conclusion === 'failure').map(c => `CI failed: ${c.name} (${c.id})`) : finding?.blockingFindings || ['Default branch advanced; rebase the complete candidate and repeat all gates'];
      if (decision.artifacts.cause === 'ci') stored.lastRootCause = digest(live.checks.filter(c => c.conclusion === 'failure').map(c => c.name).sort());
      stored.sameRootCauseFailures = stored.lastRootCause && stored.lastRootCause === stored.previousRootCause ? (stored.sameRootCauseFailures || 0) + 1 : 1;
      stored.previousRootCause = stored.lastRootCause;
      stored.repairs++;
      delete stored.shapeConcern; delete stored.shapeDiagnosis; delete stored.deliveryConcern; delete stored.candidateFailure; delete stored.hookEvidence; delete stored.preCommitHooks;
      if (decision.artifacts.stage === 'shape') delete stored.shape;
      else {
        if (stored.prNumber) {
          const pr = await this.github.pull(issue.repository, stored.prNumber);
          if (pr.merged) throw new Error('Cannot repair an already merged PR');
          // The old PR is closed through a separately granted repair capability.
          await this.github.api(`${repoPath(issue.repository)}/pulls/${stored.prNumber}`, 'PATCH', { state: 'closed' });
        }
        for (const key of ['candidate', 'delivery', 'accept', 'review', 'prNumber', 'merge']) delete stored[key];
      }
    } else throw new Error(`Unsupported operation ${operation}`);
    state.events.push({ ...decision, startedAt: state.pending.startedAt,
      ...(state.pending.writeStartedAt?{writeStartedAt:state.pending.writeStartedAt}:{}),completedAt: new Date().toISOString() });
    state.pending = null;
    return this.save(store, state);
  }
  async resume({ maxSteps = 100, onProgress = () => {} } = {}) {
    if(this.rescueInvocation||this.executionContext?.kind==='rescue')throw Error('Rescue must resume work through the original signed Actions entrypoint');
    if (!this.agentHealthOwner) { this.agentHealth = null; this.ownerGrant = null; }
    const grant = await this.grant();
    const ownerSession = this.ownerIssueSession && grant.policy.controlMode === 'owner-project' && this.dynamicUnit && grant.manifest.issues.length === 1 && Number.isSafeInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 32;
    if (grant.policy.executionMode === 'actions-v1' && (!this.actionInvocation || !this.dynamicUnit || !ownerSession && maxSteps !== 1)) throw new Error('Actions execution requires an admitted Issue; multi-stage continuation is owner-only');
    if (grant.manifest.schemaVersion === 2) return resumeDynamic(this, grant, { maxSteps, onProgress });
    const store = new Store(this.config.stateDirectory, grant.manifest.id);
    return store.lease(async () => {
      let state = await store.read();
      if (state.pending?.recoveryRequired) throw new Error('Previous Agent container cleanup is unconfirmed; operator recovery required');
      if (state.binding && canonical(state.binding) !== canonical(binding(grant.manifest, grant.policy))) throw new Error('Stored cohort authority changed; migrate with a separately approved Freeze');
      state.binding = binding(grant.manifest, grant.policy); state.issues ||= {};
      for (let step = 0; step < maxSteps; step++) {
        let snapshot = ownerSession && this.finalizationObservation || await this.observe(grant, state);
        this.finalizationObservation = null;
        if (state.pending?.atomicCommit) {
          const pendingLive = snapshot.issues[state.pending.issueId];
          if (!pendingLive.merge) {
            const atomic = state.pending.atomicCommit;
            let present = pendingLive.defaultHead === atomic;
            if (!present) {
              try { present = ['ahead','identical'].includes((await this.github.api(repoPath(pendingLive.repository) + '/compare/' + atomic + '...' + pendingLive.defaultHead)).status); }
              catch (error) { if (error.status !== 404) throw error; }
            }
            if (present) return {status:'BLOCKED',code:'MERGE_READBACK_PENDING',reason:'Atomic merge is on the default branch; waiting for GitHub PR readback without repeating writes'};
            if (pendingLive.defaultHead !== state.pending.artifacts.base) {
              state.events.push({...state.pending,outcome:'atomic-merge-not-applied-base-changed'});
              state.pending = null;
              state = await this.save(store,state);
            }
          }
        }
        let decision = { ...plan(grant.manifest, grant.policy, snapshot), executionContext: structuredClone(this.executionContext) };
        if (state.pending) {
          const pending = state.pending;
          // Reconcile interrupted writes against fresh authority and evidence.
          // Merge/closure may already have advanced; replay only that exact intent.
          const live = snapshot.issues[pending.issueId];
          const reconcilable = pending.operation === 'merge' && live?.merge || pending.operation === 'publish-shape' && live?.labels.includes('shaped') && live?.bodyHash === (grant.policy.issueScopeSource==='github-issue'?live.scopeHash:state.issues[pending.issueId].shape.bodyHash) || pending.operation === 'mark-delivered' && live?.labels.includes('delivered') || pending.operation === 'close' && live?.state === 'closed' || pending.operation === 'invalidate-shape' && live?.bodyHash === live?.scopeHash;
          if (reconcilable || decision.status === 'READY' && decision.operation === pending.operation && decision.issueId === pending.issueId && canonical(decision.artifacts) === canonical(pending.artifacts)) decision = pending;
          else if (this.dynamicUnit && !pending.writeAttempted) {
            state.events.push({ ...pending, outcome: 'not-attempted-gate-changed' });
            state.pending = null;
            state = await this.save(store, state);
          } else throw new Error(`Pending ${pending.operation} cannot be safely reconciled; no write retried`);
        }
        onProgress({ status: decision.status, operation: decision.operation, issueId: decision.issueId, code: decision.code });
        if (decision.status !== 'READY') {
          state.lastDecision = decision;
          state.events.push({ ...decision, recordedAt: new Date().toISOString(), kind: 'gate-decision' });
          if (decision.status === 'COMPLETE') {
            if (ownerSession && state.completion && state.completion.completionHash !== decision.completionHash) throw Object.assign(new Error('Stored completion differs from current evidence'),{code:'COMPLETION_UNVERIFIED'});
            state.completion = decision;
          }
          else if (state.completion) {
            state.invalidatedCompletions ||= [];
            state.invalidatedCompletions.push({ certificate: state.completion, invalidatedBy: decision });
            delete state.completion;
          }
          await this.save(store, state);
          return decision;
        }
        if(ownerSession&&this.ownerRunBudget?.shouldYield(decision.operation)){
          console.error(JSON.stringify({kind:'owner-run-budget-yield',issueId:decision.issueId,operation:decision.operation,deadline:this.ownerRunBudget.deadline}));
          return{status:'WAITING',code:'OWNER_RUN_BUDGET_EXHAUSTED',issueId:decision.issueId,operation:decision.operation};
        }
        if (!state.pending) {
          state.pending = { ...decision, startedAt: new Date().toISOString() };
          state = await this.save(store, state);
        }
        // Refresh authority after persisting intent, immediately before side effects.
        // Persisting this close intent performs no external work. The repository
        // write lease below makes the fresh pre-write observation, so avoid
        // duplicating that read here. Other operations retain their refresh.
        if (!ownerSession && !(decision.operation === 'close' && this.ownerFinalization(grant, state))) snapshot = await this.observe(grant, state);
        const checked = plan(grant.manifest, grant.policy, snapshot);
        const gateChanged = async phase => {
          const detail = { kind: 'execution-gate-changed', at: new Date().toISOString(), phase,
            issueId: decision.issueId, runId: this.actionIdentity?.runId || null,
            expected: { operation: decision.operation, artifacts: decision.artifacts, decisionId: decision.decisionId },
            actual: checked, snapshotHash: digest(snapshot), pendingWriteAttempted: state.pending?.writeAttempted === true };
          console.error(JSON.stringify(detail));
          state.lastError = detail;
          state.events.push(detail);
          await this.save(store, state);
          throw Object.assign(new Error('Gate changed before ' + phase + ': ' + (checked.code || checked.operation || checked.status) + (checked.reason ? ': ' + checked.reason : '')), { code: 'EXECUTION_GATE_CHANGED', detail });
        };
        if (!state.pending || checked.status === 'READY' && checked.operation === decision.operation && checked.issueId === decision.issueId && canonical(checked.artifacts) === canonical(decision.artifacts)) {
          try { state = await this.execute(grant, state, snapshot, decision, store); }
          catch (error) {
            state.lastError = { operation: decision.operation, issueId: decision.issueId, message: error.message, at: new Date().toISOString() };
            if (error.recoveryRequired) {
              state.pending.recoveryRequired = true;
            }
            await this.save(store, state);
            throw error;
          }
        } else if (['merge', 'publish-shape', 'close', 'mark-delivered', 'invalidate-shape'].includes(decision.operation)) {
          // Readback reconciliation never authorizes a different operation.
          const live = snapshot.issues[decision.issueId];
          const happened = decision.operation === 'merge' && live.merge || decision.operation === 'publish-shape' && live.labels.includes('shaped') && live.bodyHash === (grant.policy.issueScopeSource==='github-issue'?live.scopeHash:state.issues[decision.issueId].shape.bodyHash) || decision.operation === 'close' && live.state === 'closed' || decision.operation === 'mark-delivered' && live.labels.includes('delivered') || decision.operation === 'invalidate-shape' && live.bodyHash === live.scopeHash;
          if (!happened) await gateChanged('write');
          state = await this.execute(grant, state, snapshot, decision, store);
        } else await gateChanged('execution');
        if (ownerSession && !state.pending && ['publish-shape','reopen-recovery'].includes(state.events.at(-1)?.operation))
          return {status:'WAITING',code:'NATIVE_ISSUE_EVENT_REQUIRED',action:state.events.at(-1).operation==='publish-shape'?'labeled':'reopened'};
      }
      return { status: 'PAUSED', reason: 'Invocation step limit reached; resume continues the same cohort' };
    });
  }
  async doctor() {
    const grant = await this.grant();
    if (grant.manifest.schemaVersion === 2) return dynamicDoctor(this, grant);
    const state = await new Store(this.config.stateDirectory, grant.manifest.id).read();
    const snapshot = await this.observe(grant, state);
    const scratch = join(this.config.stateDirectory, 'doctor');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    await this.agent.login(scratch, scratch);
    return { status: 'OK', cohort: grant.manifest.id, next: plan(grant.manifest, grant.policy, snapshot), coreDigest: grant.policy.coreDigest };
  }
}

