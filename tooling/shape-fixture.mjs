// Recording adapters prove module wiring only: no model, native isolation,
// actual GitHub publication or Actions lifecycle success is certified.
import {createShapeFlow,createAgentLifecycle,selectInstructions,bodyDigest,contentIdentity,
  hookConfigurationAreas,createGithubProvider,canonicalJSON} from '../src/index.mjs';
import {operationsFixture,operationInput} from './operations-fixture.mjs';
export function shapeFixture() {
  const hash='a'.repeat(64), original='Original raw Scope';
  const body='Candidate artifacts applicability: No extra artifacts.\nCandidate hooks applicability: No hooks configured.\n```kairo-candidate\n{"artifacts":[],"hooks":[]}\n```';
  const target={repository:'example-org/core',repositoryId:'42',issueId:'I_101',databaseId:'61',number:'101'};
  const binding={authority:hash,grant:hash,policy:hash,core:hash,runtime:hash,instructions:hash,
    repositoryId:'42',issueId:'I_101',scopeHash:bodyDigest(original),shapeHash:null};
  const pin={target,binding,original:{kind:'raw-scope',body:original,hash:bodyDigest(original)},instructions:{},
    correlation:'shape-1',source:operationInput().source,operationBinding:operationInput().binding,decision:hash};
  const state={body:original,labels:['scope'],proposal:body,denied:false,dependency:'ready',roleFault:null,
    mutate:null,lost:false,failRead:false,historyMissing:false,reads:0};
  const calls=[],expected=new Map(),records=[],stores=new Map(); let execution=0;
  const issue=()=>({id:'61',node_id:'I_101',number:101,repository_url:'https://api.github.com/repos/example-org/core',
    state:'open',body:state.body});
  const provider=createGithubProvider({attempts:1,transport:async r=>{
    calls.push(r); state.reads++;
    if(state.mutate) state.mutate(r,state);
    if(state.failRead) return {status:500,body:'{}'};
    const data=r.endpoint==='/repos/example-org/core'?{id:'42',full_name:'example-org/core',private:false}:
      r.endpoint.includes('/labels')?state.labels.map((name,i)=>({id:String(80+i),name})):issue();
    return {status:200,body:JSON.stringify(data)};
  }});
  const observation={requiredArtifacts:[],scopeEvidenceReference:'fixture-original',hookObservation:{hooks:[],
    areas:hookConfigurationAreas.map(area=>({area,status:'resolved',evidenceReference:'fixture-config',detail:'No installed hooks'}))}};
  const flow=createShapeFlow({provider,authorization:{eligibility:async()=>({ok:!state.denied,observation:{repositoryId:'42',issueId:'I_101'}})},
    dependencies:{evaluate:async()=>state.evaluate ? state.evaluate() : ({outcome:state.dependency,target})},dependencyInput:{target,issues:[target]},
    current:()=>structuredClone(pin),obligations:()=>structuredClone(observation),
    evidenceCurrent:id=>({expected:structuredClone(expected.get(id)),consumed:state.replay?[expected.get(id).execution.result]:[]}),
    readBody:()=>state.proposal,
    prepareRole:async ({role,instructions,task})=>{
      const id=`execution-${++execution}`;
      const e={role,skill:'shape',id,request:id,result:id+'-result',source:null};
      const b={...binding,instructions:instructions.identity,shapeHash:role==='shape'?null:bodyDigest(task.proposedBody)};
      const receipt={version:1,stage:role,execution:e,binding:b,
        inputs:{body:bodyDigest(state.proposal),...(role==='shape-validator'?{author:task.author}:{})},
        result:{version:1,outcome:role==='shape'?'ready':'approved',failureClass:'none',summary:'recording fixture',conflicts:[]}};
      expected.set(id,structuredClone(receipt));
      const backend={readiness:async()=>({login:'available',tool:'available',isolation:'verified',read:'verified',write:'unsupported',
        evidence:['recording-contract'],limitations:['Not native isolation proof']}),
        start:async input=>{records.push({input,task});return {status:'started'};},
        collect:async()=>{
          const evidence=structuredClone(receipt);
          if(state.roleFault==='foreign') evidence.execution.id='foreign';
          if(state.roleFault==='role') evidence.execution.role='deliver';
          if(state.roleFault==='instructions') evidence.binding.instructions=hash;
          if(state.roleFault==='rejected') evidence.result={version:1,outcome:'changes_required',failureClass:'implementation_defect',summary:'reject',conflicts:[]};
          return {status:'complete',exitCode:0,evidence};},
        termination:async()=>({status:state.roleFault==='unknown'?'unknown':'terminated'}),stop:async()=>({status:'requested'}),
        cleanup:async()=>({status:'completed',residuals:[]})};
      const lifecycle=createAgentLifecycle({environment:{id:id+'-environment',agent:'recording',loginSpace:`/fixture/${id}/login`,instances:[
        {id,workspace:`/fixture/${id}/work`,registration:`/fixture/${id}/registration`,service:`/fixture/${id}/service`}]},
        instanceId:id,backend,current:()=>({expected:structuredClone(receipt),consumed:[]})});
      return {lifecycle,input:{execution:e,binding:b,instructions:{identity:instructions.identity,content:instructions.content},visibility:'public',ownership:'organization'}};
    },
    operations:async ({beforeSubmit,concurrency})=>({execute:async intent=>{
      state.concurrency=concurrency;
      let f=stores.get(intent.kind);
      if(!f){
        f=operationsFixture(intent); stores.set(intent.kind,f);
        // Reuse real retained custody and signed authorization fixture.
        f.state.beforeWrite=r=>{
          calls.push(r);
          const p=JSON.parse(r.body);
          if(intent.kind==='issue-body') state.body=p.body; else state.labels=[...new Set([...state.labels,...p.labels])];
          if(state.onWrite) state.onWrite(intent.kind,state);
        };
        f.state.mutate=d=>({...d,...issue()});
        f.state.onPublish=phase=>{if(state.onRetain)state.onRetain(phase,intent.kind);};
      }
      f.state.allowed=!state.denied;f.state.lost=state.lost;f.state.historyUnavailable=state.historyMissing;
      // Build fresh controlled-operation object, retaining the original fixture custody.
      const ops=f.fresh(undefined,beforeSubmit);
      const result=await ops.execute(intent);
      return result;
    }})});
  return {flow,state,pin,calls,records,expected,observation,stores,body,
    writes:()=>calls.filter(r=>r.method && r.method!=='GET')};
}
