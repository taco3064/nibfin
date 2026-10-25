// Disposable real Git plus existing independent-role and provider/custody contracts.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acceptFixture} from './accept-fixture.mjs';
import {operationsFixture,operationInput} from './operations-fixture.mjs';
import {createPublicationGit,createCandidatePublication,contentIdentity} from '../src/index.mjs';
export async function candidatePublicationFixture({empty=false,ownership='personal'}={}) {
  const a=await acceptFixture({empty,ownership,rich:true,originalMessage:Buffer.from('candidate\r\n\nexact message bytes'),repository:'example-org/core',issueId:'I_101'});
  const h='a'.repeat(64), b=a.pin.binding;
  const execution=(role,id)=>({role,skill:role==='shape-validator'?'shape':role,id,request:id+'-request',result:id+'-result',source:null});
  const evidence=(stage,id,inputs,result=null)=>({version:1,stage,binding:{...b},execution:execution(stage==='publication'?'shape':stage==='pre-commit-hooks'?'deliver':stage,id),inputs,result});
  const result=outcome=>({version:1,outcome,failureClass:'none',summary:'local fixture',conflicts:[]});
  const author=evidence('shape','shaper',{body:b.shapeHash},result('ready'));
  const validator=evidence('shape-validator','validator',{body:b.shapeHash,author:'shaper'},result('approved'));
  const publication=evidence('publication','published',{body:b.shapeHash,author:'shaper',validator:'validator',validation:contentIdentity(validator),readback:h});
  a.pin.deliver.inputs.publication=contentIdentity(publication);
  a.pin.deliverCurrent.expected=structuredClone(a.pin.deliver);
  const accepted=await a.flow.run();if(accepted.outcome!=='accepted')throw Error('fixture acceptance');
  const second=await a.second(accepted.evidence);if(!second.ok)throw Error('fixture hooks');
  const secondStage=evidence('pre-commit-hooks','second-stage',{candidate:a.workspace.candidate,phase:'pre-commit',accept:contentIdentity(accepted.evidence),receipt:second.receipt.identity});
  const input=operationInput('pr');Object.assign(input.binding,{scopeHash:b.scopeHash,shapeHash:b.shapeHash,
    cycle:'one',candidate:a.workspace.expected.identity,base:a.workspace.candidate.base});
  const o=operationsFixture(input);o.state.ownership=ownership==='personal'?'User':'Organization';
  const scratch=mkdtempSync(join(tmpdir(),'nibfin-publication-remote-')),remote=join(scratch,'remote.git');
  const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const git=(...args)=>execFileSync('/usr/bin/git',args,{env,stdio:['pipe','pipe','pipe']});
  git('init','--bare','--template=',remote);git('-C',a.root,'push',remote,'HEAD:refs/heads/main');
  const target={repository:'example-org/core',repositoryId:'42',issueId:'I_101',number:'101',cycle:'one',
    headRef:'nibfin/101',baseRef:'main',branchPrefix:'nibfin',paths:a.workspace.metadata.permittedPaths};
  const wrap=value=>({value,current:{expected:structuredClone(value),consumed:[]}});
  const pin={...a.pin,target,author:{name:'Core',email:'core@example.invalid',timestamp:1792800000},
    correlation:input.correlation,source:input.source,pr:{title:input.payload.title,body:input.payload.body},
    evidence:{author:wrap(author),validator:wrap(validator),publication:wrap(publication),deliver:wrap(a.pin.deliver),
      accept:wrap(accepted.evidence),secondStage:wrap(secondStage)},
    hooks:{profile:structuredClone(a.runner.profile),message:a.pin.hooks.message,executionId:'second',firstExecutionId:'first',
      first:a.first.receipt,firstReceiptCurrent:a.pin.hooks.receiptCurrent,firstStage:a.pin.hooks.stage,
      firstStageCurrent:a.pin.hooks.stageCurrent,receipt:second.receipt,receiptCurrent:{identity:second.receipt.identity,consumed:[]}}};
  const records=new Map(),commands=[],events=[];
  const state={onCurrent:null,onRetain:null,onEligibility:null,onOperations:null,onObserve:null,onPush:null,historyUnavailable:false};
  const transport=createPublicationGit({repository:target.repository,repositoryId:'42',localFixture:remote,onCommand:c=>{state.onCommand?.(c);commands.push(c);events.push(c.args.includes('push')?'push':c.args.includes('commit')?'commit-object':'git');}});
  const history={locate:({identity})=>state.historyUnavailable?{outcome:'unavailable'}:records.has(identity)
    ?{outcome:'found',records:structuredClone(records.get(identity))}:{outcome:'new',identity},
    retain:async({identity,record})=>{events.push(record.event.kind);await state.onRetain?.(record);
      records.set(identity,[...(records.get(identity)??[]),structuredClone(record)]);}};
  const capabilities={current:async()=>{await state.onCurrent?.();return structuredClone(pin);},workspace:()=>a.workspace,history,
    authorization:{eligibility:async()=>{await state.onEligibility?.();return o.authorization.eligibility({operation:'pr',context:input.binding});}},
    dependencies:{evaluate:()=>({outcome:'ready',target:{repositoryId:'42',issueId:'I_101'}})},dependencyInput:{},
    git:{repository:target.repository,repositoryId:'42',open(...args){const s=transport.open(...args);input.binding.head=s.commit;events.push('constructed');
      return {...s,observe(refs){state.onObserve?.();return s.observe(refs);},push(refs){state.onPush?.();return s.push(refs);}};}},
    operations:async options=>{await state.onOperations?.(options);return o.fresh({runId:'100',attempt:'1'},options.beforeSubmit,
      {reconcileExistingPR:options.reconcileExistingPR});}};
  const fresh=()=>createCandidatePublication(capabilities);
  return {a,o,pin,records,commands,events,state,remote,git,capabilities,fresh,run:opts=>fresh().run(opts),
    close(){a.close();rmSync(scratch,{recursive:true,force:true});}};
}
