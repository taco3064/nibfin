import { generateKeyPairSync } from 'node:crypto';
import { readFile,writeFile,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../src/core.mjs';
import { signGrant, verifyGrant } from '../src/authority.mjs';
import { Store } from '../src/store.mjs';
import { unitId,issueLeaseId } from '../src/dynamic.mjs';
import { revisionStore,verifyRequirementRevision } from '../src/requirement-revision.mjs';
import { fixture as gateFixture } from './fixtures.mjs';
export async function revisionFixture(root, options={}){
  const file=join(root,'fixture.json');let data;
  try{data=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!data){
    const keys=generateKeyPairSync('ed25519');
    const issues=[['taco3064/nibfin',10],['taco3064/nibfin',11],['taco3064/nibfin',13],
      ['taco3064/nibfin',42],['taco3064/nibfin',53],['taco3064/gh-nibfin',11],
      ...Array.from({length:70},(_,n)=>['taco3064/nibfin',n===0?8:n===1?43:100+n])].map(([repository,number],n)=>({
        id:`I_${n}`,repository,number,repositoryId:repository.includes('/gh-')?'2':'1',scopeBody:`Old Scope ${n}`,
        scopeHash:digest(`Old Scope ${n}`),dependencies:[]}));
    const edges=[['I_6','I_0'],['I_6','I_1'],['I_6','I_2'],['I_0','I_3'],['I_1','I_3'],['I_2','I_3'],['I_3','I_7'],['I_5','I_4']];
    for(const [producer,consumer] of edges) issues.find(i=>i.id===consumer).dependencies.push(producer);
    const manifest={schemaVersion:2,id:'test-parent',freezeRevision:'old-freeze',proposalRevision:'old-proposal',proposalHash:digest('Old proposal'),scheduling:'native-dependencies',membership:'fixed-approved-set',issues};
    const base=gateFixture().policy;
    const policy={...base,schemaVersion:1,grantId:'test-grant',revision:'old-policy',manifestHash:digest(manifest),controlMode:'owner-project',
      stateDirectory:root,maxParallel:2,coreDigest:digest('old-core'),runtimeHash:digest('runtime'),
      actionExecution:{repository:'taco3064/kairo'},repositories:{'taco3064/nibfin':{...base.repositories['example/one'],repositoryId:'1'},'taco3064/gh-nibfin':{...base.repositories['example/two'],repositoryId:'2'}}};
    const payload={recordId:'test-parent',actor:'test-owner',revoked:false,manifest,policy,proposal:'Old proposal'};
    const observations={},states={};
    for(const i of issues){
      const metadata={title:`Subject ${i.id}`,state:'open',labels:i.id==='I_1'?['scope','shaped']:['scope'],assignees:[],milestone:null,projects:[]};
      observations[i.id]={complete:true,issueId:i.id,repositoryId:i.repositoryId,bodyHash:i.id==='I_1'?digest('Historical Gemini Shape'):i.scopeHash,
        metadata,metadataHash:digest(metadata),blockedBy:edges.filter(e=>e[1]===i.id).map(e=>e[0]),blocking:edges.filter(e=>e[0]===i.id).map(e=>e[1]),evidence:['fixture:provider']};
      states[i.id]={revision:0,events:[],pending:null,issues:{[i.id]:i.id==='I_1'?{shape:{body:'Historical Gemini Shape',bodyHash:digest('Historical Gemini Shape')}}:{}}};
    }
    const changed=issues.slice(0,6).map(i=>({repository:i.repository,repositoryId:i.repositoryId,number:i.number,issueId:i.id,
      oldScopeHash:i.scopeHash,oldBodyHash:observations[i.id].bodyHash,oldStateHash:digest(states[i.id]),oldShapeHash:i.id==='I_1'?digest('Historical Gemini Shape'):null,
      newScopeBody:`Research Scope ${i.id}`,newScopeHash:digest(`Research Scope ${i.id}`),
      metadataHash:observations[i.id].metadataHash,retiredMetadataHash:digest({...observations[i.id].metadata,labels:['scope']}),
      blockedBy:observations[i.id].blockedBy,blocking:observations[i.id].blocking}));
    const effective=id=>changed.find(s=>s.issueId===id)?.newScopeHash || issues.find(i=>i.id===id).scopeHash;
    const revision={schemaVersion:1,kind:'owner-requirement-revision',profile:'nibfin-p1-six-subjects-20261024',recordId:'test-new-cycle',
      parentRecordId:payload.recordId,parentManifestHash:digest(manifest),parentPolicyHash:digest(policy),parentPayloadHash:digest(payload),
      planHash:digest('test-plan'),requiredCoreDigest:digest('test-core'),proposal:'New proposal',proposalHash:digest('New proposal'),
      proposalRevision:'new-proposal',cycleRevision:'new-policy',freezeRevision:'new-freeze',subjects:changed,
      compatibility:edges.map(([producer,consumer])=>({producer,consumer,producerScopeHash:effective(producer),consumerScopeHash:effective(consumer)})),
      retiredHoldHashes:[],approvedOperations:['fence-six','archive-six','retire-gemini-shape','replace-six-raw-scopes','activate-six']};
    const publicKey=keys.publicKey.export({format:'pem',type:'spki'}),privateKey=keys.privateKey.export({format:'pem',type:'pkcs8'});
    data={publicKey,privateKey,parentBundle:signGrant(payload,privateKey),revisionBundle:signGrant(revision,privateKey),observations,states,writes:[]};
    await writeFile(file,JSON.stringify(data));
  }
  const grant=verifyGrant(data.parentBundle,data.publicKey), record=verifyRequirementRevision(data.revisionBundle,grant,data.publicKey);
  const save=async()=>writeFile(file,JSON.stringify(data));
  const host={installedCoreDigest:record.requiredCoreDigest,store:revisionStore(root,grant),
    syncJournal:async()=>{}, // Synthetic durability seam; native adapter fsync is tested separately on Linux.
    authorize:async()=>{verifyRequirementRevision(data.revisionBundle,grant,data.publicKey);},
    withSubjectLeases:async(subjects,work)=>{
      const enter=async n=>n===subjects.length?work():new Store(root,issueLeaseId({id:subjects[n].issueId,repositoryId:subjects[n].repositoryId})).lease(()=>enter(n+1));
      return enter(0);
    },
    history:async s=>({stateHash:digest(data.states[s.issueId]),pending:null,candidate:false,completed:false,shapeHash:s.oldShapeHash,quiescent:true}),
    archive:async(s,h)=>({digest:digest({s,h,state:data.states[s.issueId]}),verified:true,issueId:s.issueId}),
    verifyArchives:async archives=>{if(archives.length!==6||options.badArchive)throw Error('Archive unavailable');},
    observe:async s=>structuredClone(data.observations[s.issueId]),
    mutate:async(op,s)=>{
      if(options.beforeWriteExit)process.exit(23);
      const observation=data.observations[s.issueId];
      if(op.kind==='retire-shape'){observation.metadata.labels=['scope'];observation.metadataHash=digest(observation.metadata);}
      else observation.bodyHash=s.newScopeHash;
      data.writes.push(op.id);await save();
      if(options.afterWriteExit)process.exit(24);
      if(options.loseResponse){options.loseResponse=false;throw Error('Simulated lost response');}
    }};
  const runtime={installedCoreDigest:record.requiredCoreDigest,config:{stateDirectory:root},actionIdentity:{runId:'100'},github:{api:async()=>({id:100,created_at:'2099-01-01T00:00:00Z'})}};
  return {data,grant,record,host,runtime,save,root};
}
// Test-only explicit operator recovery after spawnSync proved the child exited.
// Production never steals crash locks or infers container safety from a PID.
export async function releaseFixtureCrashLocks(f,child){
  if(!child.status || !child.pid)throw Error('No confirmed dead child');
  const stores=[f.host.store,...f.record.subjects.map(s=>new Store(f.root,issueLeaseId({id:s.issueId,repositoryId:s.repositoryId})))];
  for(const store of stores){const path=join(store.directory,'execution.lock'),lock=JSON.parse(await readFile(path,'utf8'));
    if(lock.pid!==child.pid)throw Error('Unexpected lock owner');await unlink(path);}
}
if(process.argv[2]==='--child'){
  const {migrateRequirements}=await import('../src/requirement-revision.mjs');
  const f=await revisionFixture(process.argv[3],{[process.argv[4]]:true});
  const result=await migrateRequirements(f.record,f.host);process.stdout.write(JSON.stringify(result));
}
