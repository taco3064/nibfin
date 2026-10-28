// Bound session mechanism adapted from Kairo src/role-session.mjs at
// d1b47d5e073cf15bdcdc1fbbec098401649878d9. Continuity is confined to one
// independent execution/container. Final Review never resumes the Author's
// identity. This owns session identity only, never retry permission or evidence.
import {readdirSync,lstatSync} from 'node:fs';
import {join,resolve,parse,isAbsolute} from 'node:path';
import {canonicalJSON} from './canonical.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const sessionId=value=>typeof value==='string'&&uuid.test(value);
export function sessionIdFromEvents(stdout) {
  const ids=new Set(stdout.split('\n').flatMap(line=>{
    try{const e=JSON.parse(line);return e.type==='thread.started'&&sessionId(e.thread_id)?[e.thread_id]:[];}
    catch{return [];}
  }));
  if(ids.size!==1)throw Error('Missing or ambiguous Codex session identity');
  return [...ids][0];
}
// Inspect only the CLI's disposable session-data directory, never model login
// files. Reject symlinks, ambiguous files and unavailable data before resume.
export function hasSessionData(root,id) {
  if(!sessionId(id)||typeof root!=='string'||!isAbsolute(root))return false;
  try {
    let parent=parse(root).root;
    for(const part of resolve(root).slice(parent.length).split('/').filter(Boolean)){parent=join(parent,part);if(lstatSync(parent).isSymbolicLink())return false;}
    let count=0,visited=0;
    const walk=(path,depth)=>{
      if(depth>16||++visited>10000)throw Error('Session data limit');
      const stat=lstatSync(path);if(stat.isSymbolicLink())throw Error('Unsafe session data');
      if(stat.isDirectory())for(const name of readdirSync(path))walk(join(path,name),depth+1);
      else if(stat.isFile()&&path.endsWith('.jsonl')&&path.split('/').at(-1).includes(id))count++;
    };
    walk(root,0);return count===1;
  }catch{return false;}
}
const key=(request,adapter,version)=>canonicalJSON({adapter,version,access:request.access??null,context:request.context??null});
export function createRoleSession(request,adapter,version,{persisted}={}) {
  if(persisted!==undefined&&typeof persisted!=='function')throw Error('Role session data observer required');
  const binding=key(request,adapter,version);let id=null,status='ready';
  return Object.freeze({
    get id(){return id;},
    start(){
      if(status!=='ready'||key(request,adapter,version)!==binding)throw Error('Role session requires recovery');
      if(id&&persisted&&persisted(id)!==true)throw Error('Original role session data is missing');
      status='running';
    },
    observe(observed){
      if(status!=='running'||!sessionId(observed)||id&&id!==observed)throw Error('Role session identity mismatch');
      id=observed;
    },
    // The caller is the existing provider-capacity/retry-policy owner. A failed
    // or unresolved execution cannot acquire a new session or reset its budget.
    end(retryable=false){status=retryable&&id?'ready':'recovery-required';}
  });
}
