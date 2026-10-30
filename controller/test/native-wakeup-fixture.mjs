import { UPSTREAM_REPOSITORY_ID } from '../src/owner-identity.mjs';
import { eventSource } from '../src/native-wakeup.mjs';
import { Store } from '../src/store.mjs';

// Deterministic provider seam, not live/native GitHub acceptance evidence.
export function nativeFixture(root,{grant=null,issue=null}={}) {
  issue ||= {id:'I_A',repository:'owner/app',repositoryId:'123',number:1};
  grant ||= {recordId:'parent',policy:{grantId:'g',actionEvents:{}}};
  grant.policy.actionEvents ||= {};
  grant.policy.actionEvents[issue.repository]={actorIds:['7'],signerVerification:'hmac-workflow-pin'};
  const binding={repository:issue.repository,repositoryId:issue.repositoryId,ownerId:'7',workflowPath:'.github/workflows/nibfin.yml',workflowBlob:'b'.repeat(40)};
  const runs=new Map(),inbox={seen:{}},calls=[];
  const github={repository:async r=>r==='retired-private-source'?{id:UPSTREAM_REPOSITORY_ID,owner:{id:7,type:'User'}}:
    {id:Number(issue.repositoryId),private:false,owner:{id:7},default_branch:'main'},
    api:async(path,method)=>{
      calls.push({path,method});if(method)throw Error('Read-only fixture');
      if(path.includes('/contents/'))return {sha:binding.workflowBlob};
      if(path.includes('/issues/'))return {node_id:issue.id,user:{id:7}};
      const match=path.match(/\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/);
      if(match && runs.has(match[1]))return structuredClone(runs.get(match[1]));
      throw Error('Unexpected provider read '+path);
    },list:async()=>{throw Error('No Jobs reads in approved HMAC mode');}};
  const runtime={config:{stateDirectory:root},github,publicBindings:{[issue.repository]:{binding,nibfinOwnerGitHubUserId:'7'}}};
  const state={actionReceipts:[{operation:'publish-shape',transition:{startedAt:'2026-10-23T18:56:54Z',completedAt:'2026-10-23T18:56:56Z'}}]};
  let serial=50;
  function add({createdAt='2026-10-23T18:56:55Z',issuedAt=Date.parse('2026-10-23T18:56:55Z'),action='labeled',attempt=1,...patch}={}) {
    const runId=String(++serial);
    const payload={repository:issue.repository,repositoryId:issue.repositoryId,runId,runAttempt:attempt,issuedAt,eventName:'issues',eventAction:action,issueId:issue.id,issueNumber:issue.number,...patch};
    inbox.seen[runId]={payload,targetIds:[issue.id]};
    runs.set(runId,{id:Number(runId),run_attempt:attempt,created_at:createdAt,event:payload.eventName,path:binding.workflowPath,
      repository:{id:Number(issue.repositoryId)},head_repository:{id:Number(issue.repositoryId)},head_branch:'main',head_sha:'e'.repeat(40),actor:{id:7},triggering_actor:{id:7}});
    return eventSource(payload);
  }
  async function persist(){const store=new Store(root,`actions-inbox:${grant.policy.grantId}`),s=await store.read();await store.transaction(s.revision,x=>({...x,...inbox}));}
  return {runtime,grant,issue,state,inbox,runs,calls,add,persist};
}
