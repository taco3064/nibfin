import {observeRequirementAuthority} from './requirement-source.mjs';

/** Compatibility entry; provider behavior belongs to the GitHub adapter. */
export async function observeIssueAuthority({target,...options}={}){
  const result=await observeRequirementAuthority({...options,source:{kind:'github-issue',target}});
  if(result.outcome!=='observed')return {outcome:'unavailable',reason:'issue-authority-unavailable'};
  const {source,...observed}=result;
  return {...observed,target:source.target};
}
