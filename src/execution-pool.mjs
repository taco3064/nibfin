import {repositoryCoordinates,githubId} from './identity.mjs';
import {canonicalJSON} from './canonical.mjs';
const need=ok=>{if(!ok)throw Error('execution-pool:configuration');};
function fields(value,names){
  need(value&&Object.getPrototypeOf(value)===Object.prototype);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  need(Reflect.ownKeys(value).length===names.length&&names.every(k=>Object.hasOwn(descriptors,k)
    &&Object.hasOwn(descriptors[k],'value')));
}
function identity(value){
  fields(value,['version','repository','repositoryId','ownerId','ownerType']);
  need(value.version===1&&value.ownerType==='User');githubId(value.repositoryId);githubId(value.ownerId);
  need(typeof value.repository==='string'&&value.repository.split('/').length===2
    &&repositoryCoordinates(...value.repository.split('/')).key===value.repository);
  return {...value};
}
const freeze=value=>{Object.values(value).forEach(v=>{if(v&&typeof v==='object')freeze(v);});return Object.freeze(value);};
/** Protected installation configuration only. A pool changes where a Job runs,
 * never its logical Issue, member, Grant, authority or dependency scope. GitHub
 * still has exactly the actual repository-level registrations at source.
 */
export function validateExecutionPool(value){
  fields(value,['version','source','targets']);need(value.version===1);
  const source=identity(value.source);need(Array.isArray(value.targets)&&value.targets.length>0&&value.targets.length<=32);
  const targets=value.targets.map(identity),ids=new Set(),names=new Set();
  for(const target of targets){
    need(target.ownerId===source.ownerId&&target.repository.split('/')[0]===source.repository.split('/')[0]
      &&!ids.has(target.repositoryId)&&!names.has(target.repository));
    ids.add(target.repositoryId);names.add(target.repository);
    if(target.repositoryId===source.repositoryId||target.repository===source.repository)
      need(canonicalJSON(target)===canonicalJSON(source));
  }
  need(targets.some(t=>canonicalJSON(t)===canonicalJSON(source)));
  return freeze({version:1,source,targets});
}
export function poolTarget(pool,{owner,repository,id,ownerId,ownerType}){
  const p=validateExecutionPool(pool),key=repositoryCoordinates(owner,repository).key;
  const target=p.targets.find(t=>t.repository===key&&t.repositoryId===id);
  need(target&&target.ownerId===ownerId&&target.ownerType===ownerType);return p;
}
export function poolLogicalTarget(pool,{repository,repositoryId}){
  const p=validateExecutionPool(pool);need(p.targets.some(t=>t.repository===repository&&t.repositoryId===repositoryId));return p;
}
/** Called only after protected deployment options are approved. Retain the real
 * dispatch event and Run; project the logical target separately from its source.
 * This is a context check, never Actions authentication or Issue authorization.
 */
export function projectExecutionContext({options,mode,context}){
  need(context&&options&&typeof context.repository==='string');
  githubId(context.repositoryId);githubId(context.run?.id);githubId(context.run?.attempt);
  if(options.executionPool!==undefined){
    const pool=poolLogicalTarget(options.executionPool,options);
    need(['lookup','resolve','execute','compute'].includes(mode)&&options.routing==='authenticated'
      &&options.authentication==='actions-oidc'&&context.eventName==='workflow_dispatch'
      &&context.repository===pool.source.repository&&context.repositoryId===pool.source.repositoryId);
  }else need(context.repository===options.repository&&context.repositoryId===options.repositoryId);
  return {repository:options.repository,repositoryId:options.repositoryId,run:{...context.run},
    ...(context.eventName===undefined?{}:{eventName:context.eventName}),
    ...(context.event===undefined?{}:{event:structuredClone(context.event)})};
}
/** Only these read endpoints cross the logical target boundary. Mutations,
 * collaborator reads, arbitrary source content and other repositories do not.
 */
export function poolInventoryRead(pool,request){
  const p=validateExecutionPool(pool),prefix='/repos/'+p.source.repository;
  if((request.method??'GET')!=='GET'||typeof request.endpoint!=='string')return false;
  if(request.endpoint===prefix)return true;
  const [pathname,query,...rest]=request.endpoint.split('?');
  if(rest.length||pathname!==prefix+'/actions/runners')return false;
  if(query===undefined)return true;
  const pairs=query.split('&'),seen=new Set();
  return pairs.length>0&&pairs.every(pair=>{
    const match=/^(per_page|page)=([1-9][0-9]*)$/.exec(pair);
    if(!match||seen.has(match[1]))return false;seen.add(match[1]);
    const n=Number(match[2]);return Number.isSafeInteger(n)&&n<=(match[1]==='per_page'?100:1000);
  });
}

/** Installed per logical target and workflow, never selected by dispatch inputs. */
export function validatePoolDispatch(pool,value){
  fields(value,['version','repository','repositoryId','workflow','ref','sha','workflowDigest']);
  poolLogicalTarget(pool,value);githubId(value.workflow);
  need(value.version===1&&typeof value.ref==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/.test(value.ref)
    &&!value.ref.startsWith('refs/')&&!value.ref.includes('..')&&!value.ref.includes('//')
    &&!/[/.]$/.test(value.ref)&&!value.ref.split('/').some(p=>p.endsWith('.lock'))
    &&!/^[a-f0-9]{40}$/.test(value.ref)&&/^[a-f0-9]{40}$/.test(value.sha)
    &&/^[a-f0-9]{64}$/.test(value.workflowDigest));
  return freeze({...value});
}
/** Narrow physical-source access. The logical Grant/checkpoint still owns POST. */
export function poolDispatchAccess(pool,policy,request){
  const p=validateExecutionPool(pool),d=validatePoolDispatch(p,policy),root='/repos/'+p.source.repository;
  if(request.operation!=='dispatch'||request.target!==d.workflow)return false;
  if(request.method==='POST'){
    if(request.endpoint!==`${root}/actions/workflows/${d.workflow}/dispatches`)return false;
    let body;try{body=typeof request.body==='string'?JSON.parse(request.body):request.body;}catch{return false;}
    return !!body&&canonicalJSON(Object.keys(body).sort())===canonicalJSON(['inputs','ref'])
      &&body.ref===d.ref&&body.inputs&&typeof body.inputs==='object'&&!Array.isArray(body.inputs)
      &&Object.values(body.inputs).every(v=>typeof v==='string');
  }
  if(request.method!=='GET')return false;
  if(new RegExp('^'+root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/actions/runs/[1-9][0-9]*$').test(request.endpoint))return true;
  const [path,query,...extra]=(request.endpoint??'').split('?');
  if(extra.length||path!==`${root}/actions/workflows/${d.workflow}/runs`||!query)return false;
  const seen=new Set();
  return query.split('&').every(pair=>{
    const [key,value,...rest]=pair.split('=');if(rest.length||seen.has(key))return false;seen.add(key);
    if(key==='event')return value==='workflow_dispatch';
    return ['page','per_page'].includes(key)&&/^[1-9][0-9]*$/.test(value)
      &&Number.isSafeInteger(Number(value))&&Number(value)<=(key==='per_page'?100:1000);
  })&&seen.has('event');
}
