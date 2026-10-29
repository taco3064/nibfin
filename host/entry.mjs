// First-party protected composition. No imports, environment reads or effects at construction.
export const hostModes = Object.freeze({
  lookup: Object.freeze(['authenticate','lookup']),
  resolve: Object.freeze(['authenticate','delivery','retain']),
  execute: Object.freeze(['authenticate','delivery','retain','retrieve','verifyRunner']),
  compute: Object.freeze(['authenticate','delivery','retain','retrieve','verifyRunner']),
  wake: Object.freeze(['authenticate','relay']),
  registration: Object.freeze(['authenticate','registration','retain']),
  rescue: Object.freeze(['authenticate','rescue'])
});
const fail = () => {throw Error('protected-host:configuration');};
const need = value => {if (!value) fail();};
const record = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
function fields(value, required, optional=[]) {
  need(record(value));
  const descriptors=Object.getOwnPropertyDescriptors(value);
  need(Reflect.ownKeys(value).every(k=>typeof k==='string' && [...required,...optional].includes(k)
    && Object.hasOwn(descriptors[k],'value')) && required.every(k=>Object.hasOwn(value,k)));
}
const id = v => typeof v==='string' && /^[1-9][0-9]*$/.test(v);
const repository = v => typeof v==='string' && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(v)
  && !v.split('/')[0].includes('--') && !['.','..'].includes(v.split('/')[1]);
/** Serializable options only; no module names, paths, credentials or callback JSON. */
export function validateHostOptions(options, mode,validatePool) {
  need(Object.hasOwn(hostModes,mode));
  fields(options,['version','repository','repositoryId','environment'],['groupId','authentication','routing','executionPool']);
  need(options.version===1 && repository(options.repository) && id(options.repositoryId));
  need(options.environment=== (['execute','compute'].includes(mode)?'nibfin-member':'nibfin-hosted'));
  if (Object.hasOwn(options,'authentication')) need(options.authentication==='actions-oidc');
  if (Object.hasOwn(options,'routing')) need(options.routing==='authenticated' && options.authentication==='actions-oidc'
    && (['resolve','execute','compute'].includes(mode)||mode==='lookup'&&options.executionPool!==undefined));
  if (Object.hasOwn(options,'groupId')) need(['resolve','execute','compute'].includes(mode) && id(options.groupId));
  // The approved Core supplies this pure validator. Keep this bootstrap entry
  // dependency-free so its verified bytes can still be loaded as one data URL.
  let pool=null;
  if(options.executionPool!==undefined){
    need(typeof validatePool==='function');pool=validatePool(options.executionPool);
    need(pool.targets.some(t=>t.repository===options.repository&&t.repositoryId===options.repositoryId)
      &&options.routing==='authenticated'&&['lookup','resolve','execute','compute'].includes(mode)&&options.groupId===undefined);
  }
  return Object.freeze({...options,...(pool?{executionPool:pool}:{})});
}
/** A trusted embedding host supplies executable capabilities separately from event/context.
 * No callback is invoked here. The returned object is consumed by createWorkflowEntry.
 */
export function configure({core,mode,context,deployment}={}) {
  try {
    fields(deployment,['options','capabilities'],['identity','custody','registration','roles','recovery']);
    const roleHost=deployment.roles ? (need(['execute','compute'].includes(mode) && typeof core?.createProtectedRoleHost==='function'),core.createProtectedRoleHost(deployment.roles)) : null;
    const options=validateHostOptions(deployment.options,mode,core.validateExecutionPool), capabilities=deployment.capabilities;
    need(typeof core?.createWorkflowEntry==='function' && typeof core?.createCore==='function'
      && typeof core?.createEventRelay==='function' && typeof core?.createRegistrationHost==='function');
    // Project only public context. Never forward an embedding context's secrets/env.
    need(record(context) && context.repository===options.repository && context.repositoryId===options.repositoryId);
    fields(context.run,['id','attempt']);need(id(context.run.id)&&id(context.run.attempt));
    const required=[...hostModes[mode],...(options.groupId?['group']:[])];
    const maintained=options.authentication==='actions-oidc';
    need(maintained===Object.hasOwn(deployment,'identity'));
    const adapters=maintained?core.createHostIdentityAdapters({...deployment.identity,options,mode}):null;
    const registration=mode==='registration'&&deployment.registration!==undefined;
    need(deployment.registration===undefined||registration&&maintained&&deployment.custody!==undefined);
    const durable=deployment.custody!==undefined;
    need(!durable||['resolve','execute','compute','registration'].includes(mode));
    const storage=durable&&!registration?core.createCustodyHost(deployment.custody):null;
    if(registration)fields(deployment.registration,['request','policy'],['now','timeoutMs']);
    const registered=registration?core.createProtectedRegistration({...deployment.registration,identity:adapters,
      options,source:deployment.identity.source,custody:deployment.custody}):null;
    const routed=options.routing==='authenticated';
    const supplied=required.filter(k=>!(registration&&['registration','retain'].includes(k))&&!(maintained&&k==='authenticate')&&!(durable&&['retain','retrieve'].includes(k))&&!(routed&&['verifyRunner','group'].includes(k)));
    fields(capabilities,supplied);
    for (const name of supplied) need(typeof capabilities[name]==='function');
    const run=Object.freeze({...context.run});
    const bound=Object.fromEntries(supplied.map(name=>[name,capabilities[name].bind(capabilities)]));
    if(adapters)bound.authenticate=adapters.authenticate;
    if(storage){bound.retain=storage.retainValue;bound.retrieve=storage.retrieve;}
    const contextFor = c => ({repository:options.repository,repositoryId:options.repositoryId,
      run:{id:c.run.id,attempt:c.run.attempt},...(c.eventName===undefined?{}:{eventName:c.eventName}),
      ...(c.event===undefined?{}:{event:structuredClone(c.event)})});
    const matches = identity => need(identity?.repository===options.repository && identity?.repositoryId===options.repositoryId
      && identity.visibility==='public' && ['personal','organization'].includes(identity.ownership)
      && identity.run?.id===run.id && identity.run?.attempt===run.attempt);
    const host={};let routing;
    if(registered)host.runRegistration=registered.invoke;
    for (const name of required.filter(k=>!(registration&&['registration','retain'].includes(k)))) host[name]=async argument=>{
      // Invocation is mode-bound. Reusing a configured host for another mode fails closed.
      if (name==='authenticate') need(argument.mode===mode);
      if (argument.identity) matches(argument.identity);
      const projected={...argument};
      Object.defineProperties(projected,{core:{value:core},options:{value:options}});
      if(adapters && name!=='authenticate') {
        if(['delivery','verifyRunner'].includes(name)) need((await (routed?adapters.routing.eligibility:adapters.eligibility)({capability:name})).ok);
        Object.defineProperties(projected,{provider:{value:adapters.provider},eligibility:{value:adapters.eligibility},
          ...(routed?{routing:{value:adapters.routing}}:{})});
      }
      if (argument.context) projected.context=contextFor(argument.context);
      const result=routed&&['verifyRunner','group'].includes(name)?await routing?.[name](projected):await bound[name](projected);
      if (name==='authenticate') {
        matches(result);
        return {repository:options.repository,repositoryId:options.repositoryId,run:{...run},
          visibility:'public',ownership:result.ownership};
      }
      if(name==='rescue') {
        need(result?.policy?.repository===options.repository&&result.policy.repositoryId===options.repositoryId);
        const original=result.authorize;need(typeof original==='function');
        return {...result,authorize:async argument=>{
          if(adapters)need((await adapters.eligibility({operation:'rescue'})).ok);
          return original(argument);
        }};
      }
      if (name==='delivery') {
        need(record(result) && result.request?.target?.repository===options.repository
          && result.request.target.repositoryId===options.repositoryId);
        // Core itself validates each owner, authority, dependency and queued decision.
        let config=result.config;
        if(routed) {
          need(!routing);
          routing=core.createHostRouting({adapters,current:config?.current,mode,
            maxCheckpointMs:deployment.identity.authorization.maxCheckpointMs,now:deployment.identity.now,
            ...(options.executionPool?{executionPool:options.executionPool}:{})});
          config={...config,provider:adapters.routing.provider,authorization:{eligibility:adapters.routing.eligibility},
            selector:routing.selector,...(mode==='resolve'?{}:{checkpoint:routing.checkpoint})};
        }
        need(config?.selector && typeof config.selector.select==='function');
        const select=config.selector.select.bind(config.selector);
        return {...result,config:{...config,...(roleHost?{owners:roleHost.owners(config.owners)}:{}),selector:{select:async (input,settings)=>{
          need(input.conditions?.groupId===options.groupId);
          return select(input,settings);
        }}}};
      }
      if (name==='registration') need(['new','resolved','unresolved'].includes(result?.prior));
      return result;
    };
    if(routed&&['execute','compute'].includes(mode)) {
      host.bindResolution=value=>routing.bindResolution(value);
      host.runnerObservation=()=>routing.observation();
    }
    if(storage&&['execute','compute'].includes(mode))host.beginStage=async argument=>{
      matches(argument.identity);return storage.beginStage(argument);
    };
    if(deployment.recovery) {
      need(['execute','compute'].includes(mode)&&typeof core.createRescueHost==='function');
      const {configuration,secret,attribute,onError,observe}=deployment.recovery;
      need(configuration.policy.repository===options.repository&&configuration.policy.repositoryId===options.repositoryId&&typeof observe==='function');
      const recovery=core.createRescueHost({configuration,secret,attribute,onError});
      host.recordBlocked=async argument=>{
        matches(argument.identity);
        if(!['blocked','unresolved'].includes(argument.value.disposition))return null;
        const observation=await observe(argument);
        need(observation.source.runId===run.id&&observation.source.attempt===run.attempt
          &&observation.target.repository===options.repository&&observation.target.repositoryId===options.repositoryId);
        return recovery.blocked(observation);
      };
    }
    return Object.freeze(host);
  } catch {fail();}
}
