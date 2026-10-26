// Disposable local adapters and official-response fixtures; never live evidence.
import {acceptFixture} from './accept-fixture.mjs';
import {custodyFixture} from './custody-fixture.mjs';
import {createRepairFlow,createAgentLifecycle,contentIdentity} from '../src/index.mjs';
export async function repairFixture(configure) {
  const f=await acceptFixture({empty:!!configure,repository:configure?'example-org/core':'owner/public',issueId:configure?'I_101':'I_97',configure});
  f.state.result={version:1,outcome:'changes_required',failureClass:'implementation_defect',summary:'Correct binary output',conflicts:[]};
  const rejection=await f.flow.run();
  if(rejection.outcome!=='rejected') throw Error('fixture rejection');
  const raw=structuredClone(f.expected.get(rejection.execution.id));raw.result=f.state.result;
  const cf=custodyFixture(f.pin.repository), events=[], saved=[], expectations=new Map();
  const pin={repository:f.pin.repository,visibility:'public',ownership:'personal',binding:f.pin.binding,
    scopeBody:f.pin.scopeBody,shapeBody:f.pin.shapeBody,workspace:f.workspace.expected,
    attempt:{id:'attempt-1',candidate:f.workspace.candidate,deliverExecution:'writer'},nextAttempt:'attempt-2',
    history:[],executions:[f.pin.deliver.execution],instructions:{},
    policy:{identity:f.pin.binding.policy,mode:'until-conformant',expiresAt:2000,revoked:false},
    gates:[{stage:'publication',status:'valid'}],effects:{execution:'terminated',writes:'reconciled'},merged:false,
    recovery:{allowed:true},conflictReferences:['fixture:conflict'],source:{kind:'accept'},evidence:{records:[f.pin.deliver,f.pin.hooks.stage],
      current:Object.fromEntries([f.pin.deliver,f.pin.hooks.stage].map(r=>[contentIdentity(r),{expected:r,consumed:[]}]))},
    custody:{...cf.expected,repository:f.pin.repository,issueId:f.pin.binding.issueId,cycle:'one',
      scopeHash:f.pin.binding.scopeHash,shapeHash:f.pin.binding.shapeHash,authorization:f.pin.binding.grant}};
  const state={authorized:true,dependencies:'ready',retention:'ok',diagnosis:'approved',termination:'terminated',
    pending:false,onCheckpoint:null,onRetain:null,onPrepare:null};
  const evidenceCurrent=id=>expectations.has(id)?{expected:structuredClone(expectations.get(id)),consumed:[]}:f.evidenceCurrent(id);
  let n=0;
  const caps={current:()=>structuredClone(pin),workspace:()=>f.workspace,evidenceCurrent,now:()=>1000,
    authorize:async intent=>{events.push(intent.operation);state.onCheckpoint?.(intent);return {ok:state.authorized};},
    dependencies:async()=>({outcome:state.dependencies}),
    retain:async ({manifest,payloads})=>{
      events.push('retain');state.onRetain?.();
      if(state.retention==='failed')throw Error('SECRET provider response');
      const r=await cf.publish({manifest,payloads,expected:manifest.binding});
      saved.push({manifest,payloads:new Map(payloads)});return r;
    },
    retrieve:async input=>{
      events.push('retrieve');const r=await cf.fresh().retrieve(input);
      if(state.retention==='tampered' && r.payloads)r.payloads.set('workspace.json',Buffer.from('{}'));
      if(state.retention==='missing' && r.payloads)r.payloads.delete('history.json');
      return r;
    },
    prepareRole:async ({instructions,task})=>{
      events.push('diagnosis-prepare');
      const id='diagnosis-'+(++n),execution={role:'shape-diagnosis',skill:'shape',id,request:id+'-request',result:id+'-result',source:null};
      const binding={...pin.binding,instructions:instructions.identity};
      const expected={version:1,stage:'shape-diagnosis',binding,execution,inputs:{body:pin.binding.shapeHash},
        result:{version:1,outcome:'approved',failureClass:'none',summary:'Keep Shape; correct binary output',conflicts:[]}};
      expectations.set(id,structuredClone(expected));
      const input={execution,binding,instructions:{identity:instructions.identity,content:instructions.content},visibility:'public',ownership:'personal'};
      state.onPrepare?.({input,task,expected});
      const lifecycle=createAgentLifecycle({environment:{id:id+'-env',agent:'fixture',loginSpace:'/fixture/'+id+'/login',
        instances:[{id,workspace:f.root,registration:'/fixture/'+id+'/reg',service:'/fixture/'+id+'/service'}]},instanceId:id,
        current:()=>evidenceCurrent(id),collectFailures:true,resultContext:()=>pin,backend:{
          readiness:async()=>({login:'available',tool:'available',isolation:'verified',read:'verified',write:'unsupported',evidence:['fixture'],limitations:[]}),
          start:async()=>{events.push('diagnosis-start');return {status:'started'};},
          collect:async()=>{
            if(state.pending)return {status:'pending',exitCode:null,evidence:null};
            const evidence=structuredClone(expected);
            if(state.diagnosis==='shape_defect')evidence.result={...raw.result};
            if(state.changeDiagnosis)state.changeDiagnosis(evidence);
            return {status:'complete',exitCode:0,evidence};
          },stop:async()=>{state.pending=false;state.termination='terminated';return {status:'requested'};},
          termination:async()=>({status:state.termination}),cleanup:async()=>({status:'completed',residuals:[]})}});
      return {input,lifecycle};
    }};
  const fresh=()=>createRepairFlow(caps);
  return {f,pin,raw,cf,state,events,saved,caps,fresh,flow:fresh(),expectations,close:f.close,
    concern(){raw.result={version:1,outcome:'changes_required',failureClass:'shape_defect',summary:'Exact conflict to diagnose',
      conflicts:[{scopeHash:pin.binding.scopeHash,shapeHash:pin.binding.shapeHash,
        scopeQuote:pin.scopeBody,shapeQuote:pin.shapeBody.split("\n")[0],evidenceReference:'fixture:conflict'}]};},
    advance(result){pin.history.push({issueId:pin.binding.issueId,repositoryId:pin.binding.repositoryId,attempt:result.record.attempt,
      predecessor:result.record.predecessor,policy:result.record.policy,disposition:result.disposition,source:result.record.source});
      pin.nextAttempt='attempt-'+(pin.history.length+2);raw.execution.id+='x';raw.execution.result+='x';raw.execution.request+='x';
      const e=structuredClone(raw);e.result={version:1,outcome:'accepted',failureClass:'none',summary:'expected',conflicts:[]};
      expectations.set(e.execution.id,e);
    }};
}
