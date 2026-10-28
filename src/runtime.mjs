import {observeRepositoryCI} from './github.mjs';
// Nibfin operation adapter for Kairo src/runtime.mjs execute() at
// d1b47d5e073cf15bdcdc1fbbec098401649878d9. The pre/post-hook capture algorithm
// is reused below; versioned dispatch delegates to the maintained Nibfin owners.
import {canonicalJSON} from './grants.mjs';
import {contentIdentity} from './evidence.mjs';
import {verifyWorkspace} from './workspace.mjs';
import {observeGithubCI} from './ci.mjs';
import {verifyDeployment} from './deployment.mjs';
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const need=(ok,code)=>{if(!ok)throw Error('runtime:'+code);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const copy=structuredClone;

// Reused donor pre/post-hook capture algorithm. Missing outputs and mutation
// invalidate the Candidate; a hook exit code alone never permits progression.
export async function candidateCheckpoint({stage,expected,binding,capture,execute}) {
  const failure=(result,before,after,changed)=>({...(result??{}),outcome:'blocked',
    repairRequired:{stage:'deliver',cause:'candidate-obligation',checkpoint:stage,
      ...(binding?{observation:{version:1,kind:'candidate-obligation',checkpoint:stage,binding:copy(binding),candidate:copy(expected),
        evidence:contentIdentity({before,after,result:result??null}),failureClass:changed?'implementation_defect':'external_failure'}}:{})}});
  let before=null;
  try {before=await capture();}catch { /* missing artifact or unavailable capture */ }
  if(!same(before,expected))return failure(null,before,null,before!==null);
  const result=await execute();
  let after=null;
  try {after=await capture();}catch { /* hook deletion or unavailable capture */ }
  const changed=after!==null&&!same(after,expected)||result?.diagnostic==='hooks:mismatch';
  if(result?.ok!==true||!same(after,expected))return failure(result,before,after,changed);
  return result;
}

// Only Core passes instantiated owners and a planner-selected stage. No module,
// shell command or executable is selected from Issue/event/model input.
export async function executeDeliveryOperation({p,stage,signal,resume,owned,hookInput,ciProvider,ciMode}) {
    const call=(owner,method,...args)=>{
      need(typeof owned[owner]?.[method]==='function','owner-unavailable');return owned[owner][method](...args);
    };
    if(resume){
      if(['shape','shape-validator','deliver','accept','shaper-review','repair'].includes(stage))
        return call({shape:'shape','shape-validator':'shape',deliver:'deliver',accept:'accept','shaper-review':'review',repair:'repair'}[stage],'reconcile');
      need(['publication','pr','merge','closure','delivered','recovery','fanout'].includes(stage)
        &&hash(p.operationIdentity)&&p.prior.operationIdentity===p.operationIdentity,'reconciliation');
      // These owners resolve their retained original intents before any submission.
      // Re-enter the same owner with unchanged inputs; never construct a replacement.
    }
    switch(stage) {
      case 'shape':return call('shape','author');
      case 'shape-validator':return call('shape','validate',copy(p.stageInput));
      case 'publication':return call('shape','publish',copy(p.stageInput));
      case 'deliver':return call('deliver','run');
      case 'pre-accept-hooks':case 'pre-commit-hooks':{
        const input=hookInput(stage,p);
        need(input.phase===(stage==='pre-accept-hooks'?'pre-accept':'pre-commit')
          &&same(input.expected.candidate,p.candidate)&&input.expected.binding.repository===p.target.repository
          &&input.expected.binding.scopeHash===p.binding.scopeHash&&input.expected.binding.shapeHash===p.binding.shapeHash,'hook-binding');
        if(stage==='pre-commit-hooks')need(same(input.accept,p.receipts.accept)
          &&same(input.firstStage,p.receipts['pre-accept-hooks']),'hook-evidence');
        return candidateCheckpoint({stage,expected:p.candidate,binding:p.binding,
          capture:()=>{const fresh=hookInput(stage,p);verifyWorkspace(fresh.workspace,fresh.expected);return fresh.workspace.candidate;},
          execute:()=>call('hooks','execute',input)});
      }
      case 'accept':return call('accept','run');
      case 'pr':return call('publication','run',{signal});
      case 'ci':need(p.stageInput.expected.repository===p.target.repository&&p.stageInput.expected.repositoryId===p.target.repositoryId
        &&p.stageInput.expected.head===p.head&&p.stageInput.expected.baseSha===p.base,'ci-binding');
        {
          const observation=await (ciMode==='github-repository'?observeRepositoryCI:observeGithubCI)({...copy(p.stageInput),provider:ciProvider,signal});
          // A failed check is evidence for the existing classification/repair
          // owner, never permission to launch a replacement Writer directly.
          return observation.status==='failed'?{...observation,outcome:'blocked',
            repairRequired:{stage:'repair',cause:'ci',head:p.head,base:p.base}}:observation;
        }
      case 'shaper-review':return call('review','run');
      case 'merge':return call('merge','run',{signal});
      case 'final':need(p.stageInput?.policy?.mode!=='required'||p.stageInput.policy.repositoryId===p.target.repositoryId
        &&p.stageInput.policy.commit===p.receipts.merge.inputs.commit,'deployment-binding');
        return verifyDeployment(copy(p.stageInput));
      case 'closure':return call('completion','close',{signal});
      case 'delivered':return call('completion','complete',{signal});
      case 'fanout':need(same(p.stageInput.source,p.target),'fanout-source');return call('fanout','wake',copy(p.stageInput),{signal});
      case 'recovery':return call('recovery','run',{signal});
      case 'repair':return call('repair','run',copy(p.stageInput));
      default:throw Error('core:stage');
    }
  }
