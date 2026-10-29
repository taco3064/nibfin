import {lstatSync,readdirSync,readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {byteDigest,contentIdentity} from './evidence.mjs';
import {hasSessionData,sessionId} from './role-session.mjs';
import {rescueNeed as need} from './rescue-policy.mjs';
const roles=['shape','shape-validator','deliver','accept','shaper-review'];
function directory(path) {
  need(typeof path==='string'&&resolve(path)===path&&realpathSync(path)===path,'session-directory');
  let p=path;while(p!=='/'){need(!lstatSync(p).isSymbolicLink(),'session-symlink');p=dirname(p);}
  const s=lstatSync(path);need(s.isDirectory()&&s.uid===process.getuid()&&(s.mode&0o077)===0,'session-owner');
}
/** Private host custody only, never a public package/evidence artifact. Source
 * session bytes are copied without evaluating model output or configuration. */
export function captureRescueSession({directory:root,memberId,role,session,execution,adapter='codex'}) {
  directory(root);need(adapter==='codex'&&sessionId(session)&&roles.includes(role)
    &&/^[1-9]\d*$/.test(memberId)&&typeof execution==='string'&&execution.length>0,'session-identity');
  const files=[];let total=0;
  const walk=(path,depth=0)=>{
    need(depth<=16&&files.length<1000,'session-limit');
    const s=lstatSync(path);need(!s.isSymbolicLink()&&(s.isDirectory()||s.isFile()),'session-type');
    if(s.isDirectory())for(const n of readdirSync(path)){
      need(/^[A-Za-z0-9_.-]{1,256}$/.test(n)&&!['.','..'].includes(n),'session-path');walk(join(path,n),depth+1);
    }else {
      need(s.nlink===1&&s.size<=16*1024*1024&&(total+=s.size)<=64*1024*1024,'session-limit');
      const bytes=readFileSync(path);need(bytes.length===s.size,'session-changed');
      files.push({path:path.slice(root.length+1),digest:byteDigest(bytes),bytes:bytes.toString('base64')});
    }
  };
  walk(root);need(hasSessionData(root,session),'session-data');
  const value={version:1,memberId,role,session,execution,adapter,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
  return {...value,digest:contentIdentity(value),terminated:true};
}
export function restoreRescueSession({snapshot,directory:root,expected}) {
  const {digest,terminated,...v}=snapshot;
  need(contentIdentity(v)===digest&&terminated===true&&['memberId','role','session','execution','adapter'].every(k=>v[k]===expected[k])
    &&v.version===1&&v.adapter==='codex'&&Array.isArray(v.files)&&v.files.length>0&&v.files.length<=1000,'session-binding');
  directory(root);need(readdirSync(root).length===0,'session-destination');
  let total=0;const seen=new Set();
  // Validate the whole snapshot before creating any partial restore.
  for(const f of v.files) {
    need(typeof f.path==='string'&&f.path.split('/').length<=17&&f.path.split('/').every(n=>/^[A-Za-z0-9_.-]{1,256}$/.test(n)&&!['.','..'].includes(n))
      &&!seen.has(f.path)&&typeof f.bytes==='string','session-path');seen.add(f.path);
    const bytes=Buffer.from(f.bytes,'base64');need(bytes.toString('base64')===f.bytes&&byteDigest(bytes)===f.digest
      &&bytes.length<=16*1024*1024&&(total+=bytes.length)<=64*1024*1024,'session-bytes');
  }
  for(const f of v.files) {
    const path=join(root,f.path);mkdirSync(dirname(path),{recursive:true,mode:0o700});
    directory(dirname(path));writeFileSync(path,Buffer.from(f.bytes,'base64'),{flag:'wx',mode:0o600});
  }
  need(hasSessionData(root,v.session),'session-data');
  return {memberId:v.memberId,session:v.session,digest,directory:root};
}
