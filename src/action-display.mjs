const stages=new Set(['resolve','shape','shape-validator','publication','deliver','pre-accept-hooks','accept',
 'pre-commit-hooks','pr','ci','shaper-review','merge','final','closure','delivered','fanout','recovery','repair']);
export const validDisplayStage=value=>stages.has(value);
export function actionRunName({issue,stage,correlation,rescue=false,mode}={}){
 if(!/^[1-9][0-9]*$/.test(issue)||!validDisplayStage(stage)||!/^[A-Za-z0-9_-]{1,80}$/.test(correlation)
  ||typeof rescue!=='boolean'||rescue&&!['repair','diagnose','verify'].includes(mode))throw Error('action-display:identity');
 return `${rescue?'Rescue | ':''}#${issue} | ${stage}${rescue?' | '+mode:''} | op:${correlation}`;
}
export function publicActionReason(value){
 if(typeof value!=='string')return 'Unavailable';
 return value.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,'[REDACTED]')
  .replace(/(?:Bearer|Basic)\s+[^\s]+/gi,'[REDACTED]')
  .replace(/(?:access_token|refresh_token|api_key|password|secret)\s*[:=]\s*[^\s,;]+/gi,'[REDACTED]')
  .replace(/(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY))\s*[:=]\s*[^\s,;]+/g,'[REDACTED]')
  .replace(/::/g,'：：').replace(/##\[/g,'＃＃[')
  .replace(/[\x00-\x1f\x7f-\x9f]/g,' ').replace(/\s+/g,' ').trim().slice(0,1200)||'Unavailable';
}
/** Project only retained diagnosis text and public identities. Raw provider
 * output, command lines, transcripts and model plans never become Action logs. */
export function rescueActionReport(c,result){
 const root=c.diagnosis?.record?.result?.result?.rootCause;
 return {issue:c.target.number,stage:c.target.role,ai_status:c.diagnosis?.status??'unavailable',
  blockage:publicActionReason(c.originalCode??c.code),root_cause:publicActionReason(root??'AI diagnosis unavailable: '+(c.code??'unknown')),
  repair_status:result.outcome==='RESOLVED'?'verified-resolved':result.outcome==='PENDING_VERIFICATION'?'pending-verification':'unresolved',
  verified:result.outcome==='RESOLVED'?'true':'false'};
}
export function actionLogLine(output,mode){
 const report={mode:publicActionReason(mode)};
 for(const key of ['issue','stage','status','outcome','reason','ai_status','blockage','root_cause','repair_status','verified'])
  if(typeof output[key]==='string')report[key]=publicActionReason(output[key]);
 return 'Nibfin execution '+JSON.stringify(report)+'\n';
}
