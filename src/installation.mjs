import {distributionAPI,distributionIdentity} from './distribution.mjs';
import {workflowInstallation} from './workflow-install.mjs';
import {canonicalJSON} from './canonical.mjs';
import {releaseHash,releaseVersion} from './release.mjs';
import {protectedWorkRestriction} from './owner-hold.mjs';

const need=(ok,code)=>{if(!ok)throw Error('installation:'+code);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const fields=(v,keys)=>need(v&&Object.getPrototypeOf(v)===Object.prototype
  &&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' '),'configuration');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const diagnostic=(capability,code)=>({capability,code,action:{runtime:'Install the pinned runtime and required preflight prerequisites.',
  workflow:'Install the exact pinned public workflows.',
  skills:'Restore the pinned protected Skills.',source:'Reinstall the exact approved public archive.',
  recovery:'Install and verify the pinned unified Rescue workflow, notifier and service.',
  jobAdmission:'Install the pinned job admission hook and private policy through the Runner lifecycle.'}[capability]??'Check the trusted installation configuration.'});
function expectedPin(expected){
  fields(expected,'packageVersion coreSha256');releaseVersion(expected.packageVersion);need(hash(expected.coreSha256),'source-pin');
  return structuredClone(expected);
}
async function readCapability(work){
  const controller=new AbortController();let timer;
  try{return await Promise.race([work(controller.signal),new Promise((_,reject)=>{
    timer=setTimeout(()=>{controller.abort();reject(Error('installation:read-timeout'));},30000);
  })]);}finally{clearTimeout(timer);}
}
/** Versioned producer contract for CLI/Action. All callbacks are trusted embedding
 * capabilities, NOT serializable options or model/event input. Construction has
 * no effects. Source readiness and member runtime readiness are distinct scopes.
 */
export function createInstallation(configuration){
  fields(configuration,'version expected profile observeCapability'+(Object.hasOwn(configuration,'runner')?' runner':''));
  need(configuration.version===distributionAPI.installation&&['source','member'].includes(configuration.profile)
    &&typeof configuration.observeCapability==='function','configuration');
  const expected=expectedPin(configuration.expected),profile=configuration.profile;
  const observeCapability=configuration.observeCapability;
  let runner;
  if(profile==='member'){
    fields(configuration.runner,'configuration observe probe');
    need(typeof configuration.runner.observe==='function'&&typeof configuration.runner.probe==='function','configuration');
    runner={configuration:structuredClone(configuration.runner.configuration),observe:configuration.runner.observe,probe:configuration.runner.probe};
  }else need(!Object.hasOwn(configuration,'runner'),'configuration');
  async function check(){
    let identity;
    const diagnostics=[];
    try{
      identity=distributionIdentity();
      need(identity.packageVersion===expected.packageVersion&&identity.components.core.sha256===expected.coreSha256,'source-pin');
    }catch(error){return freeze({version:1,status:'blocked',scope:profile==='member'?'member-runtime':'source-contract',identity:null,
      diagnostics:[diagnostic(['runtime','workflow','skills','source','recovery','jobAdmission'].includes(error?.capability)?error.capability:'source','missing-or-incompatible')]});}
    for(const capability of ['runtime','workflow','skills','source','recovery','jobAdmission']){
      let observation;
      try{observation=await readCapability(signal=>observeCapability(Object.freeze({capability,version:distributionAPI[capability],sha256:identity.pins[capability],signal})));}catch{}
      if(observation?.version!==distributionAPI[capability]||observation.status!=='verified'||observation.sha256!==identity.pins[capability])
        diagnostics.push(diagnostic(capability,'missing-or-incompatible'));
    }
    if(runner){
      let preflight;try{const {preflightRunner,runnerConfiguration}=await import('./runner.mjs');
        preflight=await preflightRunner({...runner,observe:config=>readCapability(signal=>runner.observe(config,{signal})),
          probe:request=>readCapability(signal=>runner.probe({...request,signal})),configuration:runnerConfiguration(runner.configuration)});}catch{}
      if(preflight?.status!=='ready')diagnostics.push(diagnostic('runtime','preflight-unavailable'));
    }
    return freeze({version:1,status:diagnostics.length?'blocked':'ready',scope:profile==='member'?'member-runtime':'source-contract',
      identity:{packageVersion:identity.packageVersion,coreSha256:identity.components.core.sha256,pins:identity.pins},diagnostics});
  }
  return Object.freeze({check,async plan(input={}){
    try{fields(input,'commit hostRepository hostCommit'+(Object.hasOwn(input,'admission')?' admission':'')
      +(Object.hasOwn(input,'executionPool')?' executionPool':'')+(Object.hasOwn(input,'repository')?' repository':''));}
    catch{return {version:1,status:'blocked',diagnostics:[diagnostic('source','invalid-installation-plan')]};}
    const {commit,hostRepository,hostCommit,admission,executionPool,repository}=input;
    if(executionPool!==undefined&&executionPool?.version!==2)return {version:1,status:'blocked',
      diagnostics:[diagnostic('source','legacy-central-pool-reconciliation-required')]};
    const readiness=await check();if(readiness.status!=='ready')return {version:1,status:'blocked',readiness};
    // Never execute the live aborting hook here, including init --check.
    let policies=null;try{
      if(profile==='member'||Object.hasOwn(input,'admission')){const {runnerJobPolicies}=await import('./runner-job-gate.mjs');policies=runnerJobPolicies(admission);}
    }catch{return {version:1,status:'blocked',readiness,
      diagnostics:[diagnostic('jobAdmission','invalid-policy')]};}
    let workflow;try{workflow=workflowInstallation({commit,hostRepository,hostCommit,...(executionPool===undefined?{}:{executionPool,repository})});}
    catch{return {version:1,status:'blocked',readiness,diagnostics:[diagnostic('source','invalid-installation-pin')]};}
    return {version:1,status:'planned',readiness,workflow,
      admission:{version:1,entry:'host/runner-job-hook.sh',nodeEntry:'host/runner-job-hook.mjs',
        policies,policyRequiredAt:'runner-registration',environment:['ACTIONS_RUNNER_HOOK_JOB_STARTED','NIBFIN_RUNNER_JOB_POLICY'],
        placement:'private-installation-outside-runner-and-participant-workspaces',manualCommandRequired:false},
      pins:readiness.identity.pins};
  }});
}
function pins(value){fields(value,'runtime workflow skills source recovery jobAdmission');need(Object.values(value).every(hash),'pins');}
/** Only plans an atomic host-managed pin switch. Never migrates a conversation,
 * clears a hold, grants authority or treats earlier evidence as current proof.
 * The host persists/reconciles its intent with the existing operation owner.
 */
export function planInstallationTransition(input,{maintenance=false,transaction}={}){
  try{
    need(typeof maintenance==='boolean','maintenance');
    need(transaction===undefined||typeof transaction==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(transaction),'transaction');
    fields(input,'version current next work');need(input.version===1,'version');
    for(const install of [input.current,input.next]){
      fields(install,'packageVersion pins');releaseVersion(install.packageVersion);pins(install.pins);
    }
    const w=input.work;
    fields(w,'restrictionsChecked hold paused unknownWrite active terminated reconciled conversations pending receipts');
    need(typeof w.active==='boolean'&&typeof w.terminated==='boolean'&&typeof w.reconciled==='boolean'
      &&Array.isArray(w.conversations)&&Array.isArray(w.pending)&&Array.isArray(w.receipts),'work');
    const restriction=protectedWorkRestriction(w);
    if(restriction&&!(maintenance&&restriction==='intentional-pause'))return {version:1,status:'blocked',code:restriction};
    if(maintenance&&w.paused!==true)return {version:1,status:'blocked',code:'maintenance-pause-required'};
    if(maintenance&&w.unknownWrite!==false)return {version:1,status:'blocked',code:'write-reconciliation-required'};
    const changed=!same(input.current,input.next);
    if(changed&&(w.active||!w.terminated||!w.reconciled))return {version:1,status:'blocked',code:'safe-boundary-required'};
    // Runtime/Skill/source pins change as one set. Even a compatible version
    // cannot silently inherit old evidence or take over the original session.
    if(input.current.packageVersion.split('.')[0]!==input.next.packageVersion.split('.')[0])
      return {version:1,status:'blocked',code:'migration-and-reauthorization-required'};
    return freeze({version:1,status:'planned',operation:changed?'switch':'unchanged',
      ...(maintenance?{maintenance:'preserve-pause'}:{}),
      ...(transaction?{transaction}:{}),
      expected:structuredClone(input.current),next:structuredClone(input.next),
      protectedState:releaseHash(canonicalJSON(w)),preserve:structuredClone({conversations:w.conversations,pending:w.pending,receipts:w.receipts}),
      evidence:changed?'fresh-gates-required':'retain-exact-identity',reauthorization:changed?'required-before-execution':'unchanged'});
  }catch{return {version:1,status:'blocked',code:'invalid-transition'};}
}
/** Host adapter for ONE local pin-set switch; it does not run delivery stages.
 * retain/observe/switchPins are trusted private installation capabilities. The
 * existing host custody/intent store owns durability and uncertain-write replay.
 * switchPins must preserve protected work and switch the whole pin set together.
 */
export async function applyInstallationTransition({current,next,observe,retain,switchPins,maintenance=false,transaction}={}){
  try{
    need([observe,retain,switchPins].every(f=>typeof f==='function'),'capabilities');
    const before=structuredClone(await observe());
    const atCurrent=same(before.installation,current),atNext=same(before.installation,next);
    if(!atCurrent&&!atNext)return {version:1,status:'blocked',code:'installation-drift'};
    const plan=planInstallationTransition({version:1,current,next,work:before.work},{maintenance,transaction});
    if(plan.status!=='planned')return plan;
    if(plan.operation==='unchanged')return {version:1,status:'unchanged',plan};
    const intent={version:1,kind:'installation-switch',identity:releaseHash(canonicalJSON(plan)),plan};
    const retained=await retain(structuredClone(intent));
    need(retained?.status==='retained'&&retained.identity===intent.identity,'intent-retention');
    // prior unknown is read-only reconciliation. Never repeat the switch.
    if(!['new','unresolved'].includes(retained.prior)||!atCurrent&&retained.prior!=='unresolved')
      return {version:1,status:'blocked',code:'intent-reconciliation-required'};
    let after=structuredClone(await observe());
    if(!same(after,before))return {version:1,status:'blocked',code:'checkpoint-drift'};
    if(retained.prior==='new'){
      try{await switchPins({expected:plan.expected,next:plan.next,protectedState:plan.protectedState,intent:intent.identity});}catch{}
      try{after=structuredClone(await observe());}catch{return {version:1,status:'unknown',code:'switch-reconciliation-required',intent:intent.identity};}
    }
    if(!same(after.work,before.work))return {version:1,status:'unknown',code:'protected-state-changed',intent:intent.identity};
    if(same(after.installation,next))return {version:1,status:'switched',intent:intent.identity,plan};
    if(same(after.installation,current)&&retained.prior==='new')return {version:1,status:'failed',code:'switch-not-applied',intent:intent.identity};
    return {version:1,status:'unknown',code:'switch-reconciliation-required',intent:intent.identity};
  }catch{return {version:1,status:'blocked',code:'installation-unavailable'};}
}
