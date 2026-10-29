// A dispatch or partial stage receipt is not proof of resolution.
export function rescueConclusion(outcome){
 if(outcome==='RESOLVED')return 'success';
 if(['DEFERRED','PENDING_VERIFICATION','STAGE_RECOVERED','SUPERSEDED','NOT_NEEDED','RECHECKED'].includes(outcome))return 'cancelled';
 return 'failure';
}
