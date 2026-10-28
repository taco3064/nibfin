import {runVerificationChild} from './verification-child.mjs';
import {randomUUID} from 'node:crypto';
import {canonicalJSON, bodyDigest} from './grants.mjs';

const fail = code => {throw Error(`verification:${code}`);};
const snapshot = v => JSON.parse(canonicalJSON(v));
const positive = n => Number.isSafeInteger(n) && n > 0;
/** A role-local deadline. Every owner receives this same clock, never a new timeout. */
export function createRoleBudget({deadlineAt, reserveMs = 300000, now = Date.now} = {}) {
  if (!positive(deadlineAt) || !positive(reserveMs) || typeof now !== 'function'
      || deadlineAt - reserveMs <= now()) fail('budget');
  const cutoff = deadlineAt - reserveMs;
  let observed = now();
  const time = () => {const n = now(); if (!Number.isSafeInteger(n) || n < observed) fail('clock'); observed = n; return n;};
  return Object.freeze({deadlineAt, cutoff,
    remaining() {return Math.max(0, cutoff - time());},
    require() {const left = Math.max(0, cutoff - time()); if (!left) fail('budget-exhausted'); return left;}
  });
}
/** Sanitization is performed before evidence leaves this owner, including discarded logs. */
export function redactRuntimeText(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret) fail('secret');
    const forms = [secret, JSON.stringify(secret).slice(1,-1), encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')];
    for (const value of forms.sort((a,b)=>b.length-a.length)) result = result.split(value).join('[redacted]');
  }
  let decoded=result;
  for(let n=0;n<4;n++) {
    decoded=decoded.replace(/\\u([a-f0-9]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))
      .replace(/\\x([a-f0-9]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
    try {decoded=decodeURIComponent(decoded);}catch{}
    if(secrets.some(secret=>decoded.includes(secret)))return '[redacted credential-bearing output]';
  }
  return result;
}
/** Shared kernel-subreaper owner reconciles descendants across process groups. */
export function verificationProcess({signal,maxBytes=1048576,...command}) {
  return runVerificationChild(command,{signal,maxBytes});
}
/** One lane per role execution. retain is the existing custody owner's protected evidence
 * capability, not a parallel store. No command may execute without durable retention.
 */
export function createVerificationLane({execution, budget, retain, process:run = verificationProcess,
  now = Date.now, secrets = []} = {}) {
  if (typeof execution !== 'string' || !execution || !budget?.remaining || typeof retain !== 'function'
      || typeof run !== 'function') fail('configuration');
  const records = new Map();let busy = false, unresolved = false;
  async function command(input, {signal, reuse = false} = {}) {
    // Reserve synchronously, before any hashing, preparation or custody operation can yield.
    if(unresolved)return {status:'unresolved'};
    if (busy) return {status:'busy'};
    busy = true;
    try {
      const v = snapshot(input);
      if (Object.keys(v).sort().join(' ') !== 'args cwd env file inputs timeoutMs'
          || typeof v.file !== 'string' || !v.file.startsWith('/') || !Array.isArray(v.args)
          || v.args.some(a=>typeof a !== 'string' || a.includes('\0'))
          || typeof v.cwd !== 'string' || !v.cwd.startsWith('/') || !positive(v.timeoutMs)
          || !v.env || typeof v.env !== 'object' || Array.isArray(v.env)
          || Object.entries(v.env).some(([k,x])=>!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof x !== 'string')
          || !v.inputs || typeof v.inputs !== 'object' || !Object.keys(v.inputs).length
          || Object.values(v.inputs).some(x=>typeof x !== 'string' || !/^[a-f0-9]{64}$/.test(x))) fail('command');
      if (redactRuntimeText(canonicalJSON(v),secrets) !== canonicalJSON(v)) fail('credential-input');
      const identity = bodyDigest(canonicalJSON({execution,...v}));
      if (reuse && records.get(identity)?.status === 'passed') return snapshot({...records.get(identity),reused:true});
      const startedAt = now(), id = randomUUID(), remaining = budget.remaining();
      let result = {status:'budget_exhausted',exitCode:null,signal:null,log:''};
      if (signal?.aborted) result.status = 'cancelled';
      else if (remaining > 0) {
        try {result = await run({...v,timeoutMs:Math.min(v.timeoutMs,remaining),signal});}
        catch {result = {status:'unresolved',exitCode:null,signal:null,log:''};}
      }
      if(signal?.aborted&&result.status==='passed')result={...result,status:'cancelled'};
      if (!['passed','failed','cancelled','timeout','output-limit','unresolved','budget_exhausted'].includes(result.status)
          || result.status === 'passed' && (result.exitCode !== 0 || result.signal))
        result = {status:'unresolved',exitCode:null,signal:null,log:''};
      if(result.status==='unresolved')unresolved=true;
      const record = {version:1,id,execution,identity,command: v,startedAt,finishedAt:now(),
        status:result.status,exitCode:result.exitCode,signal:result.signal};
      // Sensitive inputs are prohibited, not persisted with a partly redacted identity.
      const publicRecord = redactRuntimeText(canonicalJSON(record),secrets);
      if (publicRecord !== canonicalJSON(record)) fail('credential-input');
      const log = redactRuntimeText(result.log ?? '',secrets);
      const ref = await retain({record:snapshot(record),log});
      if (!ref || typeof ref !== 'string') fail('retention');
      const receipt = {...record,logReference:ref};records.set(identity,receipt);
      return snapshot(receipt);
    } finally {busy = false;}
  }
  return Object.freeze({execution,budget,command});
}
