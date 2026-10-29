// Synthetic provider/process boundaries, no donor verdict, account or live effect.
import {createHmac} from 'node:crypto';
import {createRescueRecords,createRescueDispatch,initialRescueRecords,createRescueController,createRescueProvenance,
  createRescueCompletionReceiver,contentIdentity,createRescueContinuation,rescueWorkflow} from '../src/index.mjs';
import {operationInput,operationsFixture} from './operations-fixture.mjs';
export const rescuePolicy=()=>({version:1,visibility:'public',repository:'example-org/core',repositoryId:'42',ref:'main',
  stageWorkflow:'.github/workflows/nibfin-stage.yml',stageBlob:'a'.repeat(40),rescueBlob:'c'.repeat(40),actorIds:['7'],historical:[],
  maxRepairs:3,cooldownMs:30000,jobTimeoutMinutes:180,authority:'a'.repeat(64),expiresAt:Date.now()+86400000});
export function rescueFixture() {
  const policy=rescuePolicy(),hash='a'.repeat(64),head='b'.repeat(40),secret=Buffer.alloc(32,71);
  let clock=Date.now(),stored=initialRescueRecords(),serial=Promise.resolve();const subscribers=new Set();
  const recordsConfig={load:async()=>structuredClone(stored),commit:async({expected,value})=>{
    if(stored.identity!==expected)return {outcome:'conflict'};stored=structuredClone(value);for(const f of subscribers)f();return {outcome:'retained'};
  },exclusive:fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;},subscribe:fn=>{subscribers.add(fn);return ()=>subscribers.delete(fn);}};
  const records=createRescueRecords(recordsConfig);
  const target={repository:policy.repository,repositoryId:'42',issueId:'I_101',number:'101',role:'deliver',adapter:'codex',access:'read-only',status:'UNACCEPTED',
    session:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',execution:'original-execution',memberId:'7',sessionMemberId:'7',runnerMemberId:'7',runnerId:'2',cycle:'cycle-1',
    scopeHash:hash,shapeHash:hash,candidate:hash,authority:hash,requirements:hash,source:{runId:'100',attempt:'1'}};
  const source={runId:'100',attempt:'1',head};
  const blocked={outcome:'blocked',failureClass:'external_failure',execution:target.execution,role:target.role,target:structuredClone(target),contractConflicts:[]};
  const sourceRun={id:'100',run_attempt:1,repository:{id:'42',full_name:policy.repository,private:false},path:policy.stageWorkflow,
    event:'workflow_dispatch',head_branch:'main',head_sha:head,actor:{id:'7'},triggering_actor:{id:'7'},status:'completed',conclusion:'failure',
    created_at:'2026-10-28T12:00:00Z',run_started_at:'2026-10-28T12:00:00Z',updated_at:'2026-10-28T15:01:00Z'};
  const jobs=[{id:'200',name:'execute',status:'completed',conclusion:'failure',started_at:sourceRun.run_started_at,completed_at:sourceRun.updated_at,
    check_run_url:'https://api.github.com/repos/'+policy.repository+'/check-runs/300'}];
  const flags={active:false,allowed:true,readFailure:false,workspace:hash,diagnoses:0,repairs:0,final:null,stageReceipt:null,
    diagnosisResult:{outcome:'ready',failureClass:'external_failure',body:JSON.stringify({action:'retry-original-role',steps:['Repair the attributable invocation','Rerun required verification']}),rootCause:'Invocation failure',summary:'diagnosis',evidenceReferences:['original-receipt'],contractConflicts:[]}};
  const reads=[],provider={request:async r=>{
    reads.push(r);if(flags.readFailure)return {outcome:'failed'};
    let data;if(r.endpoint.includes('/attempts/'))data=structuredClone(sourceRun);
    else if(r.endpoint.includes('/actions/workflows/'))data={id:'50',state:'active',path:r.endpoint.includes('nibfin-rescue')?rescueWorkflow:policy.stageWorkflow};
    else if(r.endpoint.includes('/commits/'))data={sha:head};
    else if(r.endpoint.includes('/contents/'))data={sha:r.endpoint.includes(rescueWorkflow)?policy.rescueBlob:policy.stageBlob,type:'file',
      path:r.endpoint.includes(rescueWorkflow)?rescueWorkflow:policy.stageWorkflow,encoding:'base64',content:Buffer.from('trusted workflow').toString('base64')};
    else data={id:'42',full_name:policy.repository,private:false};
    if(flags.mutateRead)data=flags.mutateRead(data,r);return {outcome:'read',data};
  },collection:async r=>{reads.push(r);return {outcome:'complete',data:r.endpoint.includes('/annotations')?(flags.annotations??[]):structuredClone(jobs)};}};
  const provenance=createRescueProvenance({policy,provider});
  let state={target:structuredClone(target),authority:hash,hold:false,paused:false,conflict:false,unknownWrite:false};
  const retained=[],ops=new Map();
  const continueRole=createRescueContinuation({load:async()=>({status:'UNACCEPTED',target:structuredClone(target),terminated:true,workspace:flags.workspace,session:target.session,memberId:target.memberId}),
    retain:async v=>{retained.push(v);return {outcome:'retained'};},prepare:async input=>{
      flags.repairs++;flags.freshExecution='fresh-execution';return {execution:flags.freshExecution,request:'fresh-core-request',session:target.session,memberId:target.memberId,role:target.role,
        freshBudget:true,status:'UNACCEPTED',workspace:input.workspace,access:'writer'};
    },now:()=>clock});
  const options={policy,records,provenance,current:async()=>({...structuredClone(state),stageReceipt:flags.stageReceipt}),
    authorize:async()=>({ok:flags.allowed,memberId:target.memberId,runnerId:target.runnerId,assignee:true,permission:'write',sessionMemberId:target.memberId}),
    active:async()=>flags.active,capture:async()=>flags.workspace,
    deterministic:async()=>flags.remedy??null,
    adapter:async()=>flags.adapter??{capabilities:{rescueReadOnly:true},diagnose:async()=>{flags.diagnoses++;if(flags.diagnose)await flags.diagnose();return {execution:'diagnosis-execution',terminated:true,memberId:'7',adapter:'codex',result:structuredClone(flags.diagnosisResult)};}},
    retainDiagnosis:async v=>{retained.push(v);return {outcome:'retained'};},continueRole,
    operations:async({intent,beforeSubmit})=>{
      const key=contentIdentity(intent);let f=ops.get(key);if(!f){f=operationsFixture(intent);ops.set(key,f);}
      if(flags.operation)flags.operation(f);
      return f.fresh({runId:'100',attempt:'1'},beforeSubmit);
    },
    intent:createRescueDispatch({policy,provenance,load:async({kind,target:t})=>{
      const input=operationInput('dispatch');Object.assign(input.binding,{scopeHash:t.scopeHash,shapeHash:t.shapeHash,candidate:t.candidate,number:t.number});
      return {source:input.source,binding:input.binding,workflow:{id:'50',ref:input.payload.ref,
        path:kind==='notification'?rescueWorkflow:policy.stageWorkflow}};
    }}),completion:async()=>flags.final,now:()=>clock};
  const controller=createRescueController(options),receiver=createRescueCompletionReceiver({policy,records,provenance,controller,secret,
    attribute:async()=>({target,blocked,code:'PROVIDER_FAILURE'}),now:()=>clock});
  const event=()=>({action:'completed',repository:{id:'42',full_name:policy.repository,private:false},workflow_run:structuredClone(sourceRun)});
  const signed=(e=event())=>{const bytes=Buffer.from(JSON.stringify(e));return [bytes,{'x-github-event':'workflow_run','x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(bytes).digest('hex')}];};
  return {policy,target,source,blocked,sourceRun,jobs,secret,flags,records,recordsConfig,options,controller,receiver,provider,provenance,reads,retained,ops,event,signed,
    state:()=>state,setState:v=>{state=v;},tick:ms=>clock+=ms,now:()=>clock,
    register:()=>controller.register({target,source,blocked,code:'CORE_BLOCKED'}),
    snapshot:()=>structuredClone(stored),replace:v=>stored=structuredClone(v)};
}
