import {digest,canonical} from './core.mjs';
import {createPublicKey,verify} from 'node:crypto';
import {dockerSecurity} from './docker-security.mjs';

export const runtimeConfigurationHash = config => digest({ runnerId: config.runnerId, agent: config.agent, grantSource: config.grantSource, proposalSource: config.proposalSource || null, credentialFile: config.credentialFile || null, allowedActors: config.allowedActors || [], allowedWorkflowPaths: config.allowedWorkflowPaths || [], ...(config.repairGrantSources ? { repairGrantSources: config.repairGrantSources } : {}), ...(config.controlMode ? {controlMode:config.controlMode} : {}), ...(config.actionExecution ? { actionExecution: config.actionExecution } : {}), ...(config.publicRunner ? { publicRunner: config.publicRunner, nibfinOwnerGitHubUserId: config.nibfinOwnerGitHubUserId ?? null } : {}) });

// A separately signed runtime transition preserves the original Issue/grant identity.
// Only the daemon socket and its mapped UID may change; all other settings stay pinned.
export function verifyRuntimeHardening(bundle,grant,config,installedDigest,publicKey) {
  const p=bundle?.payload,key=createPublicKey(publicKey),currentHash=runtimeConfigurationHash(config);
  const fail=()=>{throw Error('Runtime hardening is not approved for this exact authority, Core and rootless configuration');};
  if(!p||key.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(canonical(p)),key,Buffer.from(bundle.signature||'','base64'))||
      p.schemaVersion!==1||p.kind!=='owner-runtime-hardening'||grant.policy.controlMode!=='owner-project'||
      p.grantRecordId!==grant.recordId||p.manifestHash!==digest(grant.manifest)||p.policyHash!==digest(grant.policy)||
      p.fromRuntimeHash!==grant.policy.runtimeHash||p.toRuntimeHash!==currentHash||p.toCoreDigest!==installedDigest||
      !/^[a-f0-9]{64}$/.test(installedDigest)||typeof p.reason!=='string'||!p.reason.trim()||
      !p.previousAgent||typeof p.previousAgent!=='object'||Array.isArray(p.previousAgent)||p.previousAgent.dockerSecurity!==undefined)fail();
  if(runtimeConfigurationHash({...config,agent:p.previousAgent})!==p.fromRuntimeHash)fail();
  if(!dockerSecurity(config.agent)||canonical(config.agent)!==canonical({...p.previousAgent,user:'0:0',dockerSecurity:config.agent.dockerSecurity}))fail();
  return {...p,verified:true,amendmentHash:digest(bundle)};
}
