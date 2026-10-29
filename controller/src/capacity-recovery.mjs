// Container-local recovery. Only the source-bound model pair may fail over;
// authority, provider, subscription authentication, role and deadline never change.
import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {validateBudget} from './verification-runner.mjs';

const message='Selected model is at capacity. Please try a different model.';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const capacityModels=Object.freeze({primary:'gpt-6.1-sol',fallback:'gpt-6-sol'});
export function explicitModel(args) {
  const found=[];for(let i=0;i<args.length;i++)if(args[i]==='--model'||args[i]==='-m')found.push(args[++i]);else if(args[i].startsWith('--model='))found.push(args[i].slice(8));
  if(found.length>1||found.some(x=>!x))throw Error('Ambiguous model selection');return found[0]||null;
}
export function withModel(args,model) {
  if(model!==capacityModels.fallback)throw Error('Unapproved capacity fallback');
  explicitModel(args);const rest=[];for(let i=0;i<args.length;i++)if(args[i]==='--model'||args[i]==='-m')i++;else if(!args[i].startsWith('--model='))rest.push(args[i]);
  return[rest[0],'--model',model,...rest.slice(1)];
}
export async function availableFallback(args,sessionId,{home=process.env.CODEX_HOME||'/tmp/codex'}={}) {
  // Resolve the ACTUAL current turn, not a guessed CLI default. Catalog data
  // only enables this fixed source-bound pair; it cannot nominate another model.
  try{
    const paths=(await readdir(join(home,'sessions'),{recursive:true})).filter(p=>p.endsWith('.jsonl')&&p.includes(sessionId));if(paths.length!==1)return null;
    const rows=(await readFile(join(home,'sessions',paths[0]),'utf8')).trim().split('\n').map(JSON.parse),actual=rows.filter(r=>r.type==='turn_context').at(-1)?.payload?.model;
    const selected=explicitModel(args);if(actual!==capacityModels.primary||selected&&selected!==actual)return null;
    const catalog=JSON.parse(await readFile(join(home,'models_cache.json'),'utf8'));
    if(!Array.isArray(catalog.models)||!catalog.models.some(m=>m.slug===capacityModels.fallback&&m.visibility==='list'))return null;
    return{from:actual,to:capacityModels.fallback};
  }catch{return null;}
}
export function capacitySession(result,expected=null) {
  if(result.exitCode!==1)return null;
  let events;try{events=result.stdout.trim().split('\n').map(JSON.parse);}catch{return null;}
  const last=events.at(-1),ids=[...new Set(events.filter(e=>e.type==='thread.started').map(e=>e.thread_id))];
  if(last?.type!=='turn.failed'||last.error?.message!==message||events.some(e=>e.type==='turn.completed')||ids.length!==1||!uuid.test(ids[0])||expected&&expected!==ids[0])return null;
  if(events.some(e=>e.type==='error'&&e.message!==message))return null;
  return ids[0];
}
export function codexAttempt(args,input,{signal}={}) {
  return new Promise((done,reject)=>{
    const child=spawn('codex',args,{stdio:['pipe','pipe','pipe'],shell:false,signal});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.once('error',reject);child.once('close',(code)=>done({exitCode:code??1,stdout,stderr}));
    child.stdin.on('error',e=>{if(e.code!=='EPIPE')reject(e);});child.stdin.end(input);
  });
}
export async function recoverCapacity(args,input,{budget,directory='/io',run=codexAttempt,pause=(ms)=>sleep(ms,undefined,{signal}),now=Date.now,delays=[30000,60000,120000],selectFallback=async()=>null,signal}={}) {
  validateBudget(budget);
  // Only session-backed JSON exec is eligible. Ephemeral independent roles fail normally.
  if(args[0]!=='exec'||!args.includes('--json')||args.includes('--ephemeral')||args.at(-1)!=='-')throw Error('Capacity recovery requires session-backed JSON exec');
  if(delays.length>3||delays.some(x=>!Number.isSafeInteger(x)||x<0||x>120000))throw Error('Unbounded capacity recovery');
  const resume=args.indexOf('resume');let expected=resume<0?null:args[resume+1];
  if(expected&&!uuid.test(expected))throw Error('Invalid original session');
  explicitModel(args);
  const original=[...args],attempts=[];let current=[...args],prompt=input,modelOverride=null;
  for(let n=0;;n++){
    if(signal?.aborted)throw Error('Capacity recovery cancelled');
    const result=await run(current,prompt,{signal}),id=capacitySession(result,expected);
    const fallback=id&&delays[n]!==undefined&&!modelOverride?await selectFallback(current,id):null;
    if(fallback&&(fallback.from!==capacityModels.primary||fallback.to!==capacityModels.fallback||explicitModel(current)&&explicitModel(current)!==fallback.from))throw Error('Unapproved capacity fallback');
    const delay=fallback?Math.min(5000,delays[n]):delays[n];
    const retry=Boolean(id&&delay!==undefined&&!signal?.aborted&&now()+delay+60000<budget.stopVerificationAt);
    attempts.push({attempt:n+1,exitCode:result.exitCode,capacityFailure:Boolean(id),sessionId:id,model:modelOverride||fallback?.from||explicitModel(current)||'CLI default',nextModel:retry?fallback?.to||modelOverride||explicitModel(current)||'unchanged':null,
      stdoutHash:createHash('sha256').update(result.stdout).digest('hex'),retry,at:now()});
    // Summary contains no command output or credential material. Full conversation
    // and guarded verification logs remain in their existing dedicated mounts.
    await writeFile(join(directory,'capacity-recovery.json'),JSON.stringify({schemaVersion:1,deadlineAt:budget.deadlineAt,attempts},null,2)+'\n',{mode:0o600});
    if(!retry)return result;
    expected=id;await pause(delay);
    if(signal?.aborted||now()+60000>=budget.stopVerificationAt)return result;
    current=resume<0?[...original.slice(0,-1),'resume',id,'-']:[...original];
    if(fallback)modelOverride=fallback.to;
    if(modelOverride)current=withModel(current,modelOverride);
    prompt=input+'\nCAPACITY RECOVERY: Continue the SAME role, original session, candidate and fixed budget after a transient model-capacity failure. The container, /tmp, /io and work remain in place. First inspect /io/verification/active.lock and existing receipts/logs. If verification is active, wait and inspect its progress; do not launch it again or remove its lock. Retain applicable completed current-role checks for unchanged inputs. Partial output is not a pass. Changed inputs, an incomplete/killed check or independent Acceptance/CI still require the appropriate fresh proof. Return the original schema-specified result; no gate or authority changes.\n';
  }
}
export async function main(args=process.argv.slice(2)) {
  const budget=JSON.parse(await readFile('/io/verification-budget.json','utf8'));
  const input=await new Promise((done,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>text+=b);process.stdin.once('end',()=>done(text));process.stdin.once('error',reject);});
  const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGTERM',abort);process.once('SIGINT',abort);
  try{const result=await recoverCapacity(args,input,{budget,selectFallback:availableFallback,signal:controller.signal});process.stdout.write(result.stdout);process.stderr.write(result.stderr);return result.exitCode;}
  finally{process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e.message);process.exitCode=1;});
