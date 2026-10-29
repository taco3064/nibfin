import {repositoryCoordinates,githubId} from '../identity.mjs';

const need=ok=>{if(!ok)throw Error('requirement-source:target');};
function validateTarget(target){
  need(target&&Object.getPrototypeOf(target)===Object.prototype
    &&Object.keys(target).sort().join(' ')==='databaseId issueId number repository repositoryId');
  need(typeof target.repository==='string'&&target.repository.split('/').length===2
    &&repositoryCoordinates(...target.repository.split('/')).key===target.repository);
  for(const key of ['repositoryId','databaseId','number'])githubId(target[key]);
  need(typeof target.issueId==='string'&&/^[A-Za-z0-9_=-]{1,256}$/.test(target.issueId));
}
function acceptsSource(value){
  if(typeof value!=='string')return false;
  const match=/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/.exec(value);
  try{return Boolean(match&&repositoryCoordinates(match[1],match[2]).key===match[1]+'/'+match[2]&&githubId(match[3]));}
  catch{return false;}
}
function canonicalSource(target){validateTarget(target);return 'https://github.com/'+target.repository+'/issues/'+target.number;}
async function read({target,request}){
  validateTarget(target);
  const root='/repos/'+target.repository,repo=await request({endpoint:root,target:target.repositoryId});
  need(repo?.id===target.repositoryId&&repo.full_name?.toLowerCase()===target.repository
    &&repo.private===false&&repo.visibility==='public');
  const path=root+'/issues/'+target.number,issue=await request({endpoint:path,target:target.repositoryId});
  need(issue?.id===target.databaseId&&issue.node_id===target.issueId&&String(issue.number)===target.number
    &&issue.repository_url==='https://api.github.com'+root&&issue.url==='https://api.github.com'+path
    &&!Object.hasOwn(issue,'pull_request'));
  return {body:issue.body};
}
// Provider-specific identity, URL and API behavior stays in this one adapter.
// No approval, signing, writes, persistence, labels or lifecycle decisions.
export const githubIssueRequirementSource=Object.freeze({kind:'github-issue',version:1,
  validateTarget,acceptsSource,canonicalSource,read});
