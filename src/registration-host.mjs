import {createHash,createPublicKey} from 'node:crypto';
import {createCustodyHost,custodySlotIdentity} from './custody-host.mjs';
import {createRegistrationHost,createRegistrationArtifactChannel,registrationArtifactReader} from './registration.mjs';
import {canonicalJSON,contentIdentity} from './index.mjs';
import {workflowInput} from './workflow.mjs';

const need=ok=>{if(!ok)throw Error('registration-host:configuration');};
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const fields=(v,required,optional=[])=>need(v&&Object.getPrototypeOf(v)===Object.prototype
  &&required.every(k=>Object.hasOwn(v,k))&&Reflect.ownKeys(v).every(k=>typeof k==='string'
    &&[...required,...optional].includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value')));
const unknown=()=>({status:'unknown'});
/** Public readback schema owner. Inputs must come from independent original
 * source expectations, never from a downloaded record. Derivation is inert and
 * is not authentication or first-attempt authorization. */
export function registrationCustodySlots({source,workflow,ref,request}={}) {
  fields(source,['repository','repositoryId','revision','runId','attempt']);
  fields(request,['input','requester']);fields(request.requester,['id','login']);
  const captured={input:workflowInput('registration',request.input),requester:{...request.requester}};
  need(typeof workflow==='string'&&workflow.startsWith(source.repository+'/.github/workflows/')
    &&typeof ref==='string'&&ref.startsWith('refs/')&&ref.length<=256
    &&/^[1-9][0-9]*$/.test(captured.requester.id)
    &&/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(captured.requester.login));
  const requestDigest=contentIdentity({source,workflow,ref,request:captured});
  const slots=Object.fromEntries(['registration-intent','registration-result','registration-response','registration-publication']
    .map(kind=>[kind,{kind,key:requestDigest,binding:{purpose:'registration',source:structuredClone(source),request:requestDigest}}]));
  // The existing custody validator owns repository/source ID and revision bounds.
  for(const slot of Object.values(slots))custodySlotIdentity(slot);
  return slots;
}
/** Inert, first-party registration composition. Source expectations are protected
 * deployment data from the original dispatch capture, never event-selected code.
 * Custody capabilities retain immutable public-safe records under native concurrency.
 */
export function createProtectedRegistration({identity,options,source,request,policy,custody,
  now=Date.now,timeoutMs=30000}={}) {
  need(options?.authentication==='actions-oidc'&&typeof identity?.registrationSource==='function'
    &&typeof identity.registrationTransport==='function'&&typeof policy==='function'&&typeof now==='function');
  need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000);
  fields(request,['input','requester']);fields(request.requester,['id','login']);
  const expected=structuredClone(request);expected.input=workflowInput('registration',expected.input);
  const key=createPublicKey(expected.input.public_key);
  need(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails.modulusLength>=2048);
  const recipient=createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
  const p=source?.policy;
  need(p?.repository===options.repository&&p.repository_id===options.repositoryId
    &&p.actor_id===expected.requester.id&&p.event_name==='workflow_dispatch'
    &&/^[a-f0-9]{40}$/.test(p.workflow_sha));
  fields(custody,['provider','archive','publication','authorizeNew'],['secrets','maxBytes','maxFiles','retentionDays']);
  const original={repository:options.repository,repositoryId:options.repositoryId,revision:p.workflow_sha,
    runId:p.run_id,attempt:p.run_attempt};
  const slots=registrationCustodySlots({source:original,workflow:p.workflow_ref,ref:p.ref,request:expected});
  const requestDigest=slots['registration-intent'].key;
  const slot=kind=>structuredClone(slots[kind]);
  const storage=createCustodyHost({...custody,now,timeoutMs,expect:async q=>{
    need(['registration-intent','registration-result','registration-response','registration-publication'].includes(q.kind)
      &&q.key===requestDigest);return slot(q.kind);
  }});
  const read=registrationArtifactReader({provider:custody.provider,archive:custody.archive,now});
  const query=(kind,signal)=>({kind,key:requestDigest,signal});
  let busy=false;
  return Object.freeze({async invoke({input,context,identity:actor,signal:caller}) {
    if(busy)return unknown();busy=true;
    const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(caller?[caller]:[])]);
    const wait=async promise=>{
      need(!signal.aborted);let abort;
      try{return await Promise.race([promise,new Promise((_,reject)=>{
        abort=()=>reject(Error('cancelled'));signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
      })]);}finally{if(abort)signal.removeEventListener('abort',abort);}
    };
    let intent=false;
    try {
      need(same(input,expected.input)&&actor.repository===options.repository&&actor.repositoryId===options.repositoryId
        &&actor.run.id===original.runId&&actor.run.attempt===original.attempt);
      const authenticate=()=>identity.registrationSource({expected,input,context,signal});
      const authenticated=await wait(authenticate());
      const registrationId=input.level==='repository'?options.repositoryId:null;
      const bindingMatches=b=>b&&b.repository===original.repository&&b.repositoryId===original.repositoryId
        &&b.runId===original.runId&&b.attempt===original.attempt&&b.requestId===input.nibfin_registration
        &&b.requesterId===expected.requester.id&&b.level===input.level&&b.recipient===recipient
        &&(registrationId===null||b.registrationId===registrationId);
      const reconcile=async value=>{
        const publication=await wait(storage.recover(query('registration-publication',signal)));
        need(publication.outcome==='recovered'&&(publication.value.outcome==='delivered'
          ||publication.value.outcome==='unconfirmed'&&publication.value.diagnostic?.kind==='publication_unknown')); 
        need(bindingMatches(value.binding)&&typeof value.bytes==='string'&&value.bytes.length<=90000
          &&Date.parse(value.expires_at)>now());
        const bytes=Buffer.from(value.bytes,'base64'),envelope=JSON.parse(bytes.toString());
        need(same(envelope.context,value.binding));
        const ref={repository:original.repository,repositoryId:original.repositoryId,runId:original.runId,
          attempt:original.attempt,name:`registration-${input.nibfin_registration}-${original.attempt}`,artifactId:null};
        const retainedRef=publication.value.ref;
        need(retainedRef&&same({...retainedRef,artifactId:null},ref)
          &&(retainedRef.artifactId===null&&publication.value.outcome==='unconfirmed'
            ||typeof retainedRef.artifactId==='string'&&/^[1-9][0-9]*$/.test(retainedRef.artifactId)));
        ref.artifactId=retainedRef.artifactId;
        const back=await wait(read({ref,signal}));need(Buffer.from(back.bytes).equals(bytes));
        ref.artifactId=back.artifactId;
        return {outcome:'delivered',context:value.binding,expires_at:value.expires_at,
          url:`https://github.com/${input.level==='repository'?original.repository:original.repository.split('/')[0]}`,ref};
      };
      const prior=await wait(storage.recover(query('registration-result',signal)));
      if(prior.outcome==='recovered') {
        intent=true;
        const originalIntent=await wait(storage.recover(query('registration-intent',signal)));
        need(originalIntent.outcome==='recovered'&&same(originalIntent.value,{request:expected,source:original}));
        // Known cleanup failure is never promoted to delivery by upload readback.
        if(prior.value.outcome!=='delivered'&&!(prior.value.outcome==='unconfirmed'
          &&prior.value.diagnostic?.kind==='publication_unknown'))return unknown();
        const held=await wait(storage.recover(query('registration-response',signal)));
        need(held.outcome==='recovered');const recovered=await reconcile(held.value);
        if(prior.value.outcome==='delivered')need(same(recovered,prior.value));
        return {status:'retained',response:held.key};
      }
      need(prior.diagnostic?.kind==='missing-result');
      const previous=await wait(storage.recover(query('registration-intent',signal)));
      if(previous.outcome==='recovered') {
        need(same(previous.value,{request:expected,source:original}));intent=true;
        const held=await wait(storage.recover(query('registration-response',signal)));
        need(held.outcome==='recovered');
        await reconcile(held.value);
        return {status:'retained',response:held.key};
      }
      need(previous.diagnostic?.kind==='missing-result');
      // Only authorizeNew's independent durable first-attempt checkpoint can
      // authorize this retain. An empty artifact listing does not authorize it.
      intent=true; // A failed intent publication may itself have an external effect.
      const retained=await wait(storage.retain({...query('registration-intent',signal),
        value:{request:expected,source:original},identity:actor}));
      need(retained.outcome==='retained');
      const channel={publish:async value=>{
        need(bindingMatches(value.binding));
        const held=await storage.retain({...query('registration-response',signal),identity:actor,
          value:{binding:value.binding,expires_at:value.expires_at,bytes:Buffer.from(value.bytes).toString('base64')}});
        need(held.outcome==='retained');
        const facilities=await wait(custody.publication({slot:slot('registration-response'),phase:'response',signal}));
        const published=await createRegistrationArtifactChannel({...facilities,read,now}).publish(value);
        const confirmation=await storage.retain({...query('registration-publication',signal),identity:actor,value:published});
        need(confirmation.outcome==='retained');return published;
      }};
      const issuer=createRegistrationHost({authenticate:async()=>{
        const fresh=await authenticate();need(same(fresh,authenticated));return fresh;
      },policy,transport:identity.registrationTransport,channel,now,timeoutMs});
      const result=await wait(issuer.issue(input.nibfin_registration,{signal}));
      const saved=await wait(storage.retain({...query('registration-result',signal),identity:actor,value:result}));
      need(['retained','recovered'].includes(saved.outcome));return {status:result.outcome,response:result.outcome==='delivered'
        ?contentIdentity(slot('registration-response')):saved.key};
    } catch {return intent?unknown():{status:'blocked'};}
    finally{busy=false;}
  }});
}
