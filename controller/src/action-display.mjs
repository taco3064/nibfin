// Display hints never select authority, Issue membership or a lifecycle stage.
export function issueReference(issue){
 if(!/^[\w.-]+\/[\w.-]+$/.test(issue?.repository??'')||!Number.isSafeInteger(issue.number)||issue.number<1)return undefined;
 return issue.repository.split('/')[1]+'#'+issue.number;
}
export const requestIssueReference=(request,issues=[])=>issueReference(issues.find(i=>i.id===request.issueId&&i.repository===request.repository));
export const actionRunTitle=(reference,id)=>'upstream | '+(reference||'Request')+' | '+id;
export async function eventIssueReference(github,p,resolveIssues){
 const direct=issueReference({repository:p.repository,number:p.issueNumber});if(direct)return direct;
 try{
  if(p.issueId&&github.issueById){const issue=await github.issueById(p.issueId);if(issue?.id===p.issueId&&issue.repository?.nameWithOwner===p.repository){const reference=issueReference({repository:p.repository,number:issue.number});if(reference)return reference;}}
  if(p.eventName==='workflow_run'&&resolveIssues){const issues=await resolveIssues(p),numbers=[...new Set(issues.filter(i=>i.repository===p.repository&&issueReference(i)).map(i=>i.number))].sort((a,b)=>a-b);if(numbers.length)return p.repository.split('/')[1]+'#'+numbers.join('+');}
 }catch{/* A failed optional label read never prevents authenticated work. */}
 return p.repository.split('/')[1];
}
