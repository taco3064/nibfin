import {canonicalJSON,bodyDigest} from './canonical.mjs';
import {exportAuthority} from './authority.mjs';
import {requirementSourceAdapter} from './requirement-sources/index.mjs';

const need=ok=>{if(!ok)throw Error('requirement-source:observation');};
const token=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f*]/.test(v);
/** The protected installation selects {kind,target} and its provider connection.
 * Adapters return raw requirement bytes, never approval or workflow decisions.
 * Common cancellation, revision, authority and failure semantics live here. */
export async function observeRequirementAuthority({source,provider,cycle,approvalId,
  signal:caller,timeoutMs=30000,now=Date.now}={}){
  let signal,abort,active=true;
  try{
    need(source&&Object.getPrototypeOf(source)===Object.prototype
      &&Object.keys(source).sort().join(' ')==='kind target');
    const adapter=requirementSourceAdapter(source.kind),selected=JSON.parse(canonicalJSON(source));
    adapter.validateTarget(selected.target);
    need(typeof provider?.request==='function'&&typeof now==='function'&&token(cycle)&&token(approvalId));
    need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000);
    const startedAt=now();need(Number.isSafeInteger(startedAt)&&startedAt>=0);
    signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(caller?[caller]:[])]);
    need(!signal.aborted);
    const request=async input=>{
      need(active&&!signal.aborted&&input&&Object.keys(input).sort().join(' ')==='endpoint target'
        &&typeof input.endpoint==='string'&&typeof input.target==='string');
      const response=await provider.request({...input,method:'GET',operation:'authority-read',
        correlation:'requirement-source',signal});
      need(active&&!signal.aborted&&response?.outcome==='read');return response.data;
    };
    const observed=await Promise.race([Promise.resolve().then(()=>adapter.read({target:structuredClone(selected.target),request})),
      new Promise((_,reject)=>{abort=()=>reject(Error('cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);
    need(typeof observed?.body==='string'&&observed.body.trim().length>0&&Buffer.byteLength(observed.body)<=1048576);
    const observedAt=now();need(Number.isSafeInteger(observedAt)&&observedAt>=startedAt
      &&observedAt-startedAt<timeoutMs&&!signal.aborted);
    const canonicalSource=adapter.canonicalSource(selected.target);need(adapter.acceptsSource(canonicalSource));
    return {outcome:'observed',source:selected,startedAt,observedAt,
      ...(observed.document?{document:JSON.parse(canonicalJSON(observed.document))}:{}),authority:exportAuthority({source:canonicalSource,
      revision:bodyDigest(observed.body),cycle,approvalId,components:[{id:'scope',kind:'section',body:observed.body,references:[]}]})};
  }catch{return {outcome:'unavailable',reason:'requirement-source-unavailable'};}
  finally{active=false;if(abort)signal.removeEventListener('abort',abort);}
}
