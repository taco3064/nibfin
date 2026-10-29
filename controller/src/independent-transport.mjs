import {readFile,lstat,realpath} from 'node:fs/promises';
import {createPublicKey,verify} from 'node:crypto';
import {digest,canonical} from './core.mjs';
import {coreDigest,verifyGrant,verifyCoreUpgrade,outside} from './authority.mjs';
import {runtimeConfigurationHash} from './runtime-configuration.mjs';
import {validatePublicPolicy} from './runner-binding.mjs';

const repository='taco3064/nibfin',repositoryId='1427838662';
const fail=()=>{throw Error('Independent transport is not approved for this exact installation and authority');};
export function verifyIndependentTransport(record,grant,config,installed,publicKey){
 const p=record?.payload,key=createPublicKey(publicKey),settings=config.independentTransport;
 if(!p||key.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(canonical(p)),key,Buffer.from(record.signature??'','base64'))||
  p.schemaVersion!==1||p.kind!=='nibfin-independent-transport'||p.grantRecordId!==grant.recordId||p.manifestHash!==digest(grant.manifest)||p.policyHash!==digest(grant.policy)||
  p.coreDigest!==installed||p.runtimeHash!==runtimeConfigurationHash(config)||!settings||p.settingsHash!==digest(settings)||!p.reason?.trim())fail();
 const e=p.execution;
 if(e?.repository!==repository||e.repositoryId!==repositoryId||e.visibility!=='public'||e.workflowPath!=='.github/workflows/nibfin-controller.yml'||e.ref!=='main'||
  !/^[a-f0-9]{40}$/.test(e.workflowBlob??'')||e.ownerId!==grant.actorGitHubUserId||e.identityMode!=='local-gh'||
  !Array.isArray(e.actorIds)||!e.actorIds.length||e.actorIds.some(id=>![grant.actorGitHubUserId,'41898282'].includes(String(id)))||
  !Array.isArray(e.workers)||e.workers.length!==2||new Set(e.workers.map(w=>w.id)).size!==2||e.workers.some(w=>!Number.isSafeInteger(w.id)||w.id<1||!/^nibfin-worker-[12]$/.test(w.name))||
  canonical(e.runnerIds)!==canonical(e.workers.map(w=>w.id))||e.coordinationHostId!==grant.policy.actionExecution.coordinationHostId||e.jobName!=='execute'||e.handoffJobName!=='handoff'||
  p.rescueWorkflow!=='.github/workflows/nibfin-rescue.yml'||!/^[a-f0-9]{40}$/.test(p.rescueWorkflowBlob??'')||
  p.authorityRepository!==repository||p.authorityRepositoryId!==repositoryId||!settings.authorityFile||!settings.proposalFile||!settings.registryPath)fail();
 const n=p.notifications;
 if(!n||canonical(Object.keys(n).sort())!==canonical(['actionEvents','publicRunner'])||canonical(Object.keys(n.publicRunner?.bindings??{}).sort())!==canonical(Object.keys(grant.policy.publicRunner.bindings).sort())||
  n.publicRunner.rootId!==grant.policy.publicRunner.rootId||canonical(Object.keys(n.actionEvents??{}).sort())!==canonical(Object.keys(grant.policy.actionEvents).sort()))fail();
 validatePublicPolicy({...grant.policy,...n});
 for(const [name,b] of Object.entries(n.publicRunner.bindings)){
  const old=grant.policy.publicRunner.bindings[name];
  if(b.repositoryId!==old.repositoryId||b.ownerId!==old.ownerId||b.runnerId!==old.runnerId||b.workflowPath!=='.github/workflows/nibfin-events.yml')fail();
  const event=n.actionEvents[name],previous=grant.policy.actionEvents[name];
  if(!event||canonical(event)!==canonical(previous))fail();
 }
 return {...p,verified:true,amendmentHash:digest(record)};
}
async function protectedText(path,runtime){
 if(typeof path!=='string'||!path.startsWith('/etc/nibfin/')||!outside(runtime.root,path)||!outside(runtime.config.stateDirectory,path)||!outside(runtime.config.agent.authDirectory,path))fail();
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||stat.nlink!==1||(stat.mode&0o027)!==0||await realpath(path)!==path||stat.size>8*1024*1024)fail();
 return readFile(path,'utf8');
}
// Only two exact historical source descriptors are mapped to protected local
// files. The signed original Grant remains unchanged; no private API fallback.
export async function installIndependentTransport(runtime){
 const settings=runtime.config.independentTransport;if(!settings)return null;
 const [bytes,publicKey,installed]=await Promise.all([protectedText(settings.authorityFile,runtime),readFile(runtime.config.publicKeyPath,'utf8'),coreDigest(runtime.root)]);
 const bundle=JSON.parse(bytes),grant=verifyGrant(bundle,publicKey);
 const upgrade=[bundle.coreUpgrade,...(bundle.coreUpgrades??[])].find(r=>r?.payload?.toCoreDigest===installed);
 const approval=verifyCoreUpgrade(upgrade,grant,installed,publicKey);
 const transport=verifyIndependentTransport(bundle.transportMigration,grant,runtime.config,installed,publicKey);
 if(approval.controllerSource?.repository!==repository)fail();
 const proposal=await protectedText(settings.proposalFile,runtime);
 await protectedText(settings.registryPath,runtime);
 if(digest(proposal)!==grant.manifest.proposalHash)fail();
 const github=runtime.github;
 if(!github.independentOriginalText){
  github.independentOriginalText=github.text.bind(github);
  github.independentOriginalApi=github.api.bind(github);
  github.api=(path,...args)=>{if(/^\/repos\/taco3064\/kairo(?:\/|$)/.test(path))throw Error('Retired private execution repository is disabled');return github.independentOriginalApi(path,...args);};
 }
 github.text=async source=>{
  if(canonical(source)===canonical(runtime.config.grantSource))return protectedText(settings.authorityFile,runtime);
  if(canonical(source)===canonical(runtime.config.proposalSource))return protectedText(settings.proposalFile,runtime);
  return github.independentOriginalText(source);
 };
 github.ownerAuthority={repository,repositoryId};
 runtime.transport=transport;runtime.coreUpgrade=approval;
 return transport;
}
export const executionPolicy=(runtime,grant)=>runtime.actionExecutionPolicy?.(grant)??grant.policy.actionExecution;
export const notificationPolicy=(runtime,grant)=>runtime.transport?{...grant.policy,...runtime.transport.notifications}:grant.policy;
export const rescueWorkflowFor=runtime=>runtime.transport?.rescueWorkflow??'.github/workflows/kairo-rescue.yml';
export const rescueNamespace=runtime=>runtime.transport?':'+runtime.transport.amendmentHash:'';
