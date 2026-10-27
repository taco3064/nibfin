import {createCore, createEventRelay, createRegistrationHost, canonicalJSON, githubId,
  memberRunnerLabel, repositoryCoordinates} from './index.mjs';

export const workflowVersion = 1;
const writers = new Set(['publication','pr','merge','closure','delivered','fanout','recovery']);
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const need = ok => {if (!ok) throw Error('workflow:contract');};
const opaque = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const exact = (v,keys) => need(v && same(Object.keys(v).sort(),keys.split(' ').sort()));
const deliveryKeys = 'nibfin_request nibfin_correlation';
export function workflowInput(mode,input) {
  exact(input, mode === 'registration' ? 'nibfin_registration public_key level'
    : ['resolve','execute','compute'].includes(mode) ? deliveryKeys+' issue'+(mode!=='resolve'?' resolution':'')
    : mode === 'lookup' ? deliveryKeys : 'event');
  if (mode === 'registration') {
    need(opaque(input.nibfin_registration) && ['repository','organization'].includes(input.level)
      && typeof input.public_key === 'string' && input.public_key.length <= 8192);
  } else if (mode !== 'wake') {
    need(opaque(input.nibfin_request) && opaque(input.nibfin_correlation));
    if (['resolve','execute','compute'].includes(mode)) githubId(input.issue);
    if (['execute','compute'].includes(mode)) need(opaque(input.resolution));
  }
  need(['lookup','resolve','execute','compute','wake','registration'].includes(mode));
  return structuredClone(input);
}
export function projectIssue(event) {
  return {name:'issues',payload:{action:event.action,repositoryId:String(event.repository.id),
    issueId:event.issue.node_id,number:String(event.issue.number),
    label:event.action==='opened' ? (event.issue.labels.some(l=>l.name==='scope')?'scope':null) : event.label?.name??null,
    stateReason:event.issue.state_reason??null}};
}
// Selector output is cumulative routing, not a list of alternative members.
export async function workflowRoute(selection,conditions,target,group) {
  const r=selection?.routing, labels=r?.labels;
  need(selection?.outcome==='selected' && r.runnerLabel===memberRunnerLabel(selection.memberId)
    && ['linux','windows','macos'].includes(r.platform) && r.platform===conditions.platform
    && Array.isArray(labels) && labels.length<=100 && labels.every(l=>typeof l==='string'
      && l.length>0 && l.length<=256 && !/[\x00-\x1f\x7f]/.test(l)) && new Set(labels).size===labels.length);
  const required=[...new Set(['self-hosted',conditions.platform,...conditions.labels.map(l=>l.toLowerCase()),r.runnerLabel])];
  need(same([...labels].sort(),required.sort()) && labels.filter(l=>l.startsWith('nibfin-user-')).length===1
    && r.groupId===conditions.groupId);
  if (r.groupId===undefined) return {labels};
  githubId(r.groupId); need(typeof group==='function');
  const verified=await group({id:r.groupId,target,labels});
  need(verified?.id===r.groupId && verified.repositoryId===target.repositoryId && verified.allowed===true
    && typeof verified.name==='string' && verified.name.length>0 && verified.name.length<=256
    && !/[\x00-\x1f\x7f]/.test(verified.name));
  return {group:verified.name,labels};
}
/** Constructor capabilities are protected executable configuration, never JSON inputs. */
export function createWorkflowEntry(host) {
  need(typeof host?.authenticate==='function');
  const attempted=new Set();
  return Object.freeze({async invoke(mode,raw,context,{signal}={}) {
    let activeRequest=null;
    try {
      const input=workflowInput(mode,raw), identity=await host.authenticate({mode,input,context,signal});
      need(identity?.visibility==='public' && ['personal','organization'].includes(identity.ownership));
      githubId(identity.repositoryId); githubId(identity.run.id); githubId(identity.run.attempt);
      const [owner,repo]=identity.repository.split('/');need(repositoryCoordinates(owner,repo).key===identity.repository);
      need(identity.repository===context.repository && identity.repositoryId===context.repositoryId && same(identity.run,context.run));
      if (mode==='wake') {
        // createEventRelay independently authenticates projection, source and predecessor.
        const result=await createEventRelay(await host.relay({identity,context})).wake(input.event);
        return {status:result.outcome};
      }
      if (mode==='lookup') {
        const target=await host.lookup({identity,input});
        need(target.repository===identity.repository && target.repositoryId===identity.repositoryId);
        githubId(target.number);return {status:'resolved',issue:target.number};
      }
      if (mode==='registration') {
        const spec=await host.registration({identity,input,context});
        if (spec.prior!=='new') return {status:spec.prior==='resolved'?'retained':'unknown'};
        const key='registration:'+input.nibfin_registration;need(!attempted.has(key));attempted.add(key);
        const authenticate=spec.config.authenticate;
        const config={...spec.config,authenticate:async (...args)=>{
          const source=await authenticate(...args);
          need(source.repository===identity.repository && source.repositoryId===identity.repositoryId
            && source.runId===identity.run.id && source.attempt===identity.run.attempt
            && source.requestId===input.nibfin_registration && source.publicKey===input.public_key && source.level===input.level);
          return source;
        }};
        // Durable existing custody/intent owner must retain before any token POST.
        await host.retain({kind:'registration-intent',key,value:{input,identity},identity,signal});
        activeRequest=input.nibfin_registration;
        const result=await createRegistrationHost(config).issue(spec.handle,{signal});
        const response=await host.retain({kind:'registration-result',key,value:result,identity,signal});need(opaque(response));
        return {status:result.outcome,response};
      }
      const spec=await host.delivery({identity,input,context}), request=structuredClone(spec.request);
      need(request.target.repository===identity.repository && request.target.repositoryId===identity.repositoryId
        && request.target.number===input.issue && request.request===input.nibfin_request && same(request.run,identity.run));
      let selection,conditions;
      const config={...spec.config,selector:{select:async (value,options)=>{
        conditions=value.conditions; selection=await spec.config.selector.select(value,options);return selection;
      }}};
      const core=createCore(config);
      if (mode==='resolve') {
        const inspected=await core.inspect(request,{signal});
        if (inspected.reason!=='evaluated' || !same(inspected.current,request.expected)) return {status:'blocked',selected:'false',reason:'invalid-or-unavailable'};
        const route=await workflowRoute(selection,conditions,request.target,host.group);
        const resolution=await host.retain({kind:'resolution',key:request.request,
          value:{request,route,memberId:selection.memberId},identity,signal});need(opaque(resolution));
        return {status:'selected',selected:'true',runs_on:JSON.stringify(route),resolution,
          execution_mode:writers.has(request.expected.stage)?'execute':'compute'};
      }
      const held=await host.retrieve({kind:'resolution',key:input.resolution,identity,signal});
      need(same(held.request,request) && writers.has(request.expected.stage)===(mode==='execute'));
      const inspected=await core.inspect(request,{signal});
      need(inspected.reason==='evaluated' && same(inspected.current,request.expected));
      const route=await workflowRoute(selection,conditions,request.target,host.group);
      need(same(route,held.route) && selection.memberId===held.memberId
        && await host.verifyRunner({identity,request,route,memberId:held.memberId,signal})===true);
      const key='execute:'+request.request+':'+identity.run.id+':'+identity.run.attempt;
      need(!attempted.has(key));attempted.add(key);
      activeRequest=request.request;
      if(typeof host.beginStage==='function') {
        const prior=await host.beginStage({identity,key:request.request,value:{request},signal});
        if(prior.outcome==='recovered') {
          const value=prior.value;
          need(value.version===1&&same(value.target,request.target)&&value.cycle===request.cycle
            &&value.request===request.request&&same(value.run,request.run)&&same(value.requested,request.expected)
            &&['completed','blocked','waiting','superseded','rejected','unresolved'].includes(value.disposition)&&opaque(prior.key));
          return {status:value.disposition,reference:prior.key};
        }
        need(prior.outcome==='started');
      }
      const result=await core.run(request,{signal});
      const reference=await host.retain({kind:'stage-result',key:request.request,value:result,identity,signal});need(opaque(reference));
      return {status:result.disposition,reference};
    } catch {return activeRequest?{status:'unresolved',request:activeRequest,reason:'result-reconciliation-required'}
      :{status:'blocked',selected:'false',reason:'invalid-or-unavailable'};}
  }});
}
