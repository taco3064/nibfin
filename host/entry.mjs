// First-party protected composition. No imports, environment reads or effects at construction.
export const hostModes = Object.freeze({
  lookup: Object.freeze(['authenticate','lookup']),
  resolve: Object.freeze(['authenticate','delivery','retain']),
  execute: Object.freeze(['authenticate','delivery','retain','retrieve','verifyRunner']),
  compute: Object.freeze(['authenticate','delivery','retain','retrieve','verifyRunner']),
  wake: Object.freeze(['authenticate','relay']),
  registration: Object.freeze(['authenticate','registration','retain'])
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
export function validateHostOptions(options, mode) {
  need(Object.hasOwn(hostModes,mode));
  fields(options,['version','repository','repositoryId','environment'],['groupId','authentication']);
  need(options.version===1 && repository(options.repository) && id(options.repositoryId));
  need(options.environment=== (['execute','compute'].includes(mode)?'nibfin-member':'nibfin-hosted'));
  if (Object.hasOwn(options,'authentication')) need(options.authentication==='actions-oidc');
  if (Object.hasOwn(options,'groupId')) need(['resolve','execute','compute'].includes(mode) && id(options.groupId));
  return Object.freeze({...options});
}
/** A trusted embedding host supplies executable capabilities separately from event/context.
 * No callback is invoked here. The returned object is consumed by createWorkflowEntry.
 */
export function configure({core,mode,context,deployment}={}) {
  try {
    fields(deployment,['options','capabilities'],['identity','custody']);
    const options=validateHostOptions(deployment.options,mode), capabilities=deployment.capabilities;
    need(typeof core?.createWorkflowEntry==='function' && typeof core?.createCore==='function'
      && typeof core?.createEventRelay==='function' && typeof core?.createRegistrationHost==='function');
    // Project only public context. Never forward an embedding context's secrets/env.
    need(record(context) && context.repository===options.repository && context.repositoryId===options.repositoryId);
    fields(context.run,['id','attempt']);need(id(context.run.id)&&id(context.run.attempt));
    const required=[...hostModes[mode],...(options.groupId?['group']:[])];
    const maintained=options.authentication==='actions-oidc';
    need(maintained===Object.hasOwn(deployment,'identity'));
    const adapters=maintained?core.createHostIdentityAdapters({...deployment.identity,options,mode}):null;
    const durable=deployment.custody!==undefined;
    need(!durable||['resolve','execute','compute','registration'].includes(mode));
    const storage=durable?core.createCustodyHost(deployment.custody):null;
    const supplied=required.filter(k=>!(maintained&&k==='authenticate')&&!(durable&&['retain','retrieve'].includes(k)));
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
    const host={};
    for (const name of required) host[name]=async argument=>{
      // Invocation is mode-bound. Reusing a configured host for another mode fails closed.
      if (name==='authenticate') need(argument.mode===mode);
      if (argument.identity) matches(argument.identity);
      const projected={...argument};
      Object.defineProperties(projected,{core:{value:core},options:{value:options}});
      if(adapters && name!=='authenticate') {
        if(['delivery','verifyRunner'].includes(name)) need((await adapters.eligibility({capability:name})).ok);
        Object.defineProperties(projected,{provider:{value:adapters.provider},eligibility:{value:adapters.eligibility}});
      }
      if (argument.context) projected.context=contextFor(argument.context);
      const result=await bound[name](projected);
      if (name==='authenticate') {
        matches(result);
        return {repository:options.repository,repositoryId:options.repositoryId,run:{...run},
          visibility:'public',ownership:result.ownership};
      }
      if (name==='delivery') {
        need(record(result) && result.request?.target?.repository===options.repository
          && result.request.target.repositoryId===options.repositoryId);
        // Core itself validates each owner, authority, dependency and queued decision.
        need(result.config?.selector && typeof result.config.selector.select==='function');
        const select=result.config.selector.select.bind(result.config.selector);
        return {...result,config:{...result.config,selector:{select:async (input,settings)=>{
          need(input.conditions?.groupId===options.groupId);
          return select(input,settings);
        }}}};
      }
      if (name==='registration') need(['new','resolved','unresolved'].includes(result?.prior));
      return result;
    };
    if(storage&&['execute','compute'].includes(mode))host.beginStage=async argument=>{
      matches(argument.identity);return storage.beginStage(argument);
    };
    return Object.freeze(host);
  } catch {fail();}
}
