import {createAssigneeSelector} from './selection.mjs';
import {observeRunnerBindings} from './runners.mjs';
import {canonicalJSON} from './grants.mjs';
import {validateExecutionPool,poolLogicalTarget} from './execution-pool.mjs';

const need=ok=>{if(!ok)throw Error('host-routing:unavailable');};
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
/** Protected-host composition. Observations come exclusively from its maintained
 * identity adapter; event/input/environment fields are never Runner evidence.
 * Construction does no reads. The current Core plan owns registration records.
 */
export function createHostRouting({adapters,current,mode,maxCheckpointMs,now=Date.now,executionPool}={}) {
  need(typeof adapters?.routing?.provider?.request==='function' && typeof current==='function' && typeof adapters?.memberEligibility==='function'
    && typeof adapters?.observeExecution==='function' && ['resolve','execute','compute'].includes(mode));
  const selector=createAssigneeSelector({provider:adapters.routing.provider,now,maxCheckpointMs,
    authorizationFor:member=>({eligibility:(intent,settings)=>adapters.memberEligibility(member,intent,settings)})});
  const memberMode=mode!=='resolve';
  const pool=executionPool===undefined?null:validateExecutionPool(executionPool);
  function selectedInput(input){
    if(pool){
      need(input.executionPool===undefined||same(input.executionPool,pool));
      return {...input,executionPool:pool};
    }
    need(input.executionPool===undefined);return input;
  }
  let selected=null, retained=null, observed=null;
  function bounded(signal) {
    const started=now();let latest=started;
    const fresh=timestamp=>{const current=now();
      need(!signal?.aborted && Number.isSafeInteger(current) && Number.isSafeInteger(timestamp)
        && timestamp>=latest && current>=timestamp && current-started<maxCheckpointMs);latest=current;
    };
    fresh(started);
    return {finish:()=>fresh(now()),provider:{request:async r=>{
      fresh(now());const result=await adapters.routing.provider.request({...r,signal});
      if(result.outcome==='read')fresh(result.observedAt);else fresh(now());return result;
    }}};
  }
  async function actual(input,selection,signal) {
    const checkpoint=bounded(signal);
    const observation=await adapters.observeExecution({signal});
    const p=await current();
    if(pool)poolLogicalTarget(pool,p.target);
    need(observation.operatorId===selection.memberId && observation.repository===p.target.repository && observation.repositoryId===p.target.repositoryId
      && same(observation.run,p.invocation.run));
    // A repository registration cannot receive a Job from another repository.
    // Organization registrations may serve other allowed repos in that org.
    need(pool
      ? input.registration.level==='repository'&&observation.sourceRepositoryId===pool.source.repositoryId
        &&observation.sourceRepository===pool.source.repository
      : input.registration.level==='repository'
      ? observation.sourceRepositoryId===input.target.id
        && observation.sourceRepository===p.target.repository
      : observation.sourceRepository.split('/')[0]===input.registration.organization.toLowerCase());
    const records=input.records.filter(r=>r.memberId===selection.memberId);
    const inventory=await observeRunnerBindings(checkpoint.provider,{...input,records,signal,correlation:'actual-runner',
      conditions:{...input.conditions,labels:[]}});
    need(inventory.outcome==='matched' && inventory.inventory==='complete');
    const instance=inventory.instances.find(i=>i.runnerId===observation.runnerId);
    need(instance?.outcome==='matched' && instance.memberId===selection.memberId
      && (input.conditions.groupId===undefined || instance.groupId===input.conditions.groupId)
      && instance.observation.platform===input.conditions.platform && instance.observation.status==='online'
      && selection.routing.labels.every(label=>instance.observation.labels.includes(label)));
    checkpoint.finish();
    observed=structuredClone(observation);
    return true;
  }
  async function select(input,settings={}) {
    try{input=selectedInput(input);}catch{return {outcome:'blocked',reason:'execution_pool_unavailable'};}
    const memberId=retained?.memberId;
    const selection=await selector.select(input,{...settings,...(memberId?{memberId}:{})});
    if(memberMode && selection.outcome==='selected') {
      try {need(retained && selection.memberId===retained.memberId);await actual(input,selection,settings.signal);}
      catch {return {outcome:'blocked',reason:'actual_runner_unavailable'};}
    }
    selected=selection;
    return selection;
  }
  return Object.freeze({selector:Object.freeze({select}),
    // Called only after Workflow compares the retained request with the current
    // request. Pin the member, not an instance; GitHub may choose any valid one.
    bindResolution(value){need(memberMode && !retained);retained=structuredClone(value);},
    async verifyRunner({request,route,memberId,signal}) {
      try {
        need(retained && same(retained.request,request) && same(retained.route,route)
          && retained.memberId===memberId && selected?.memberId===memberId);
        return await actual(selectedInput((await current()).selectionInput),selected,signal);
      } catch {return false;}
    },
    async group({id,target,labels}) {
      const p=await current(),input=p.selectionInput;
      need(selected?.outcome==='selected' && input.conditions.groupId===id
        && target.repositoryId===p.target.repositoryId && same(labels,selected.routing.labels));
      const inventory=await observeRunnerBindings(adapters.routing.provider,{...input,
        records:input.records.filter(r=>r.memberId===selected.memberId),
        conditions:{...input.conditions,labels:[]},correlation:'route-group'});
      need(inventory.outcome==='matched' && inventory.inventory==='complete');
      const group=inventory.groups?.find(g=>g.id===id);need(group?.access==='allowed');
      return {id,name:group.name,repositoryId:target.repositoryId,allowed:true};
    },
    observation(){return observed?structuredClone(observed):null;},
    async checkpoint({signal}={}) {
      need(memberMode && retained);
      const p=await current(),selection=await select(p.selectionInput,{signal});
      need(selection.outcome==='selected' && selection.memberId===retained.memberId);
      // Recheck the retained route without treating order changes as reassignment.
      need(same(selection.routing.labels,retained.route.labels));
    }
  });
}
