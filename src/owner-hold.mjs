// Negative restrictions supplied by the trusted authorization checkpoint. Their
// authentication belongs to the existing authority owner, never Issue/model data.
// A false or missing observation is not proof that restrictions were checked.
export function protectedWorkRestriction(state){
  if(!state||state.restrictionsChecked!==true)return 'restrictions-unavailable';
  if(state.hold!==null)return 'owner-hold';
  if(state.paused!==false)return 'intentional-pause';
  if(state.unknownWrite!==false)return 'write-reconciliation-required';
  return null;
}
// The retained Rescue v1 checkpoint uses explicit boolean hold/paused/unknownWrite
// fields. Adapt that schema here, retaining the same negative restriction owner.
export function rescueWorkRestriction(state){
  const observed=state&&['hold','paused','unknownWrite'].every(k=>Object.hasOwn(state,k));
  return protectedWorkRestriction({restrictionsChecked:observed===true,
    hold:state?.hold===false?null:state?.hold,paused:state?.paused,unknownWrite:state?.unknownWrite});
}
