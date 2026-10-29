import {exportAuthority} from './authority.mjs';
import {bodyDigest} from './canonical.mjs';
import {repositoryCoordinates,githubId} from './identity.mjs';

const need=ok=>{if(!ok)throw Error('issue-authority:identity');};
const exact=(v,names)=>need(v&&Object.getPrototypeOf(v)===Object.prototype
  &&Object.keys(v).sort().join(' ')===names.split(' ').sort().join(' '));
const token=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f*]/.test(v);
/** Read a fresh native Issue as requirements. The caller independently binds
 * this target and approval/cycle to its protected installation. This function
 * cannot approve, sign, dispatch, persist a snapshot or invalidate old work. */
export async function observeIssueAuthority({provider,target,cycle,approvalId,signal:caller,timeoutMs=30000,now=Date.now}={}){
  try{
    exact(target,'repository repositoryId issueId databaseId number');
    need(typeof provider?.request==='function'&&typeof now==='function'&&token(cycle)&&token(approvalId));
    need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000);
    need(typeof target.repository==='string'&&target.repository.split('/').length===2
      &&repositoryCoordinates(...target.repository.split('/')).key===target.repository);
    for(const k of ['repositoryId','databaseId','number'])githubId(target[k]);
    need(typeof target.issueId==='string'&&/^[A-Za-z0-9_=-]{1,256}$/.test(target.issueId));
    const expected=structuredClone(target),startedAt=now();need(Number.isSafeInteger(startedAt)&&startedAt>=0);
    const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(caller?[caller]:[])]);
    const read=async endpoint=>{
      need(!signal.aborted);let abort;
      try{
        const result=await Promise.race([Promise.resolve().then(()=>provider.request({method:'GET',endpoint,
          target:expected.repositoryId,operation:'authority-read',correlation:'issue-authority',signal})),new Promise((_,reject)=>{
          abort=()=>reject(Error('cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        })]);
        need(!signal.aborted&&result?.outcome==='read');return result.data;
      }finally{if(abort)signal.removeEventListener('abort',abort);}
    };
    const root='/repos/'+expected.repository,repo=await read(root);
    need(repo?.id===expected.repositoryId&&repo.full_name?.toLowerCase()===expected.repository
      &&repo.private===false&&repo.visibility==='public');
    const path=root+'/issues/'+expected.number,issue=await read(path);
    need(issue?.id===expected.databaseId&&issue.node_id===expected.issueId&&String(issue.number)===expected.number
      &&issue.repository_url==='https://api.github.com'+root&&issue.url==='https://api.github.com'+path
      &&!Object.hasOwn(issue,'pull_request')&&typeof issue.body==='string'&&issue.body.trim().length>0
      &&Buffer.byteLength(issue.body)<=1048576);
    const observedAt=now();need(Number.isSafeInteger(observedAt)&&observedAt>=startedAt&&observedAt-startedAt<timeoutMs&&!signal.aborted);
    const source='https://github.com/'+expected.repository+'/issues/'+expected.number;
    const revision=bodyDigest(issue.body);
    return {outcome:'observed',target:expected,startedAt,observedAt,authority:exportAuthority({source,revision,cycle,approvalId,
      components:[{id:'scope',kind:'section',body:issue.body,references:[]}]})};
  }catch{return {outcome:'unavailable',reason:'issue-authority-unavailable'};}
}
