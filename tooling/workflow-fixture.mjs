// Local caller interpreter: no eval, live Runner or Actions success claim.
import {readFileSync} from 'node:fs';
import {parseDocument} from 'yaml';
import {workflowFiles,createWorkflowEntry,canonicalJSON} from '../src/index.mjs';
import {coreFixture} from './core-fixture.mjs';
export function workflowYAML() {
  return new Map(workflowFiles.filter(p=>p.endsWith('.yml')).map(p=>{
    const doc=parseDocument(readFileSync(new URL('../'+p,import.meta.resolve('../src/index.mjs')),'utf8'),{uniqueKeys:true});
    if(doc.errors.length) throw doc.errors[0];return [p,doc.toJS()];
  }));
}
export function expression(source,context) {
  const s=source.trim();
  if (s.includes(' || ')) return s.split(' || ').map(v=>expression(v,context)).find(Boolean)??false;
  if (s.includes(' && ')) return s.split(' && ').every(v=>Boolean(expression(v,context)));
  if (s.includes(' == ')) {const [a,b]=s.split(' == ');return expression(a,context)===expression(b,context);}
  if (/^'[^']*'$/.test(s)) return s.slice(1,-1);
  const call=/^(fromJSON|toJSON)\((.*)\)$/.exec(s);
  if(call) return call[1]==='fromJSON'?JSON.parse(expression(call[2],context)):JSON.stringify(expression(call[2],context));
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s)) throw Error('unsupported expression');
  return s.split('.').reduce((v,k)=>v?.[k],context);
}
export function resolveYAML(value,context) {
  if (Array.isArray(value)) return value.map(v=>resolveYAML(v,context));
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveYAML(v,context)]));
  if (typeof value!=='string') return value;
  if (/^\$\{\{ [^{}]+ \}\}$/.test(value)) return expression(value.slice(3,-2),context);
  return value.replace(/\$\{\{ ([^{}]+) \}\}/g,(_,s)=>String(expression(s,context)));
}
export function callInputs(workflow,event,input) {
  const schema=workflow.on[event].inputs, result={};
  if (Object.keys(input).some(k=>!Object.hasOwn(schema,k))) throw Error('unknown input');
  for (const [key,s] of Object.entries(schema)) {
    const value=input[key]??s.default??(s.type==='string'?'':s.type==='boolean'?false:0);
    if (typeof value!==s.type || s.required && value==='') throw Error('required/type');result[key]=value;
  }
  return result;
}
export async function workflowFixture() {
  const f=coreFixture(),request=await f.queued(),saved=new Map(),records=[];
  const input={issue:request.target.number,nibfin_request:request.request,nibfin_correlation:'correlation-1'};
  const identity={repository:request.target.repository,repositoryId:request.target.repositoryId,run:request.run,visibility:'public',ownership:'organization'};
  const context=structuredClone(identity),state=Object.assign(f.state,{runner:true,source:true});
  const config={provider:f.provider,current:()=>structuredClone(f.pin),authorization:f.authorization,
    dependencies:f.dependencies,selector:f.selector,owners:f.owners};
  const host={authenticate:async v=>{if(!state.source)throw Error('source');return identity;},
    lookup:async ({input:i})=>{if(i.nibfin_request!==input.nibfin_request||i.nibfin_correlation!==input.nibfin_correlation)throw Error('unknown');return request.target;},
    delivery:async ({input:i})=>{if(i.nibfin_correlation!==input.nibfin_correlation)throw Error('correlation');return {config,request};},
    retain:async record=>{records.push(record);const ref='ref-'+record.kind;saved.set(ref,structuredClone(record));return ref;},
    retrieve:async ({key,identity:i})=>{const record=saved.get(key);if(!record||canonicalJSON(i)!==canonicalJSON(record.identity))throw Error('custody');return record.value;},
    verifyRunner:async()=>state.runner,
    group:async ({id,target})=>({id,name:'Verified group',repositoryId:target.repositoryId,allowed:true})};
  const entry=createWorkflowEntry(host);
  return {...f,host,entry,records,saved,state,config,identity,context,input,queuedRequest:request,
    resolve:()=>entry.invoke('resolve',input,context),
    execute:(resolution,mode='compute')=>entry.invoke(mode,{...input,resolution},context)};
}
