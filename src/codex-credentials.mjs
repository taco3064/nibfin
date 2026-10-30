// The official CLI may refresh its private writable copy. Only this owner can
// publish it back; model output and task configuration never select a login path.
import fs from 'node:fs';
import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const need=(v,c)=>{if(!v)throw Error('codex-credentials:'+c);};
const sha=b=>createHash('sha256').update(b).digest('hex');
function bytes(path){const h=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(h);need(s.isFile()&&s.nlink===1&&s.size>0&&s.size<=65536,'file');const b=fs.readFileSync(h);need(b.length===s.size,'file-drift');return b;}finally{fs.closeSync(h);}}
function value(b){const v=JSON.parse(b);need(v.auth_mode==='chatgpt'&&!v.OPENAI_API_KEY&&typeof v.tokens?.access_token==='string'&&v.tokens.access_token,'login');return v;}
function expiry(v){try{const p=JSON.parse(Buffer.from(v.tokens.access_token.split('.')[1],'base64url'));return Number.isSafeInteger(p.exp)?p.exp*1000:0;}catch{return 0;}}
function privateFile(path){const s=fs.lstatSync(path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0,'private-file');}
function write(path,b){fs.writeFileSync(path,b,{flag:'wx',mode:0o600});const h=fs.openSync(path,'r');try{fs.fsyncSync(h);}finally{fs.closeSync(h);}}
async function lease(directory){
 const path=join(directory,'maintenance.lock');try{write(path,'');}catch(e){if(e.code!=='EEXIST')throw e;}privateFile(path);
 const child=spawn('/usr/bin/flock',['--exclusive','--nonblock',path,process.execPath,'-e',"process.stdin.resume();process.stdin.once('end',()=>process.exit(0));process.stdout.write('locked\\n');"],
  {env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','ignore']});
 child.stdin.on('error',()=>{});let closed=false,acquired=false;
 const ended=new Promise(resolve=>{child.once('error',()=>{closed=true;resolve();});child.once('close',()=>{closed=true;resolve();});});
 try{await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('codex-credentials:lease-timeout')),5000);
  child.stdout.on('data',b=>{text+=b;if(text==='locked\n'){acquired=true;clearTimeout(timer);resolve();}else if(text.length>32){clearTimeout(timer);reject(Error('codex-credentials:lease-protocol'));}});
  ended.then(()=>{clearTimeout(timer);if(!acquired)reject(Error('codex-credentials:refresh-busy'));});});}
 catch(e){child.stdin.end();if(!closed)child.kill('SIGTERM');await ended;throw e;}
 return{assert:()=>need(!closed,'lease-lost'),release:async()=>{child.stdin.end();await ended;}};
}

/** Container entry: a read-only source, as in the former controller, becomes a
 * writable CODEX_HOME copy. Host account/config/session directories stay outside. */
export function initializeCodexCredentials({source='/auth/auth.json',target='/tmp/home/.codex/auth.json'}={}){
 const original=bytes(source);value(original);fs.mkdirSync(dirname(target),{recursive:true,mode:0o700});write(target,original);return original;
}
/** Called after the official client exits, even when the model task failed. */
export function stageCodexCredentials(original,{target='/tmp/home/.codex/auth.json',output='/credential-update'}={}){
 const current=bytes(target);value(current);if(current.equals(original))return false;
 write(join(output,'auth.json'),current);
 write(join(output,'receipt.json'),JSON.stringify({version:1,original:sha(original),updated:sha(current)}));return true;
}

/** Host: fresh tokens allow parallel roles. A role that can reach expiration
 * holds the one member lease until its refresh is durably published. Unknown
 * outcomes retain a journal and block replay after the kernel lease is released. */
export async function prepareCodexCredentials({login,root,execution,deadlineAt,now=Date.now}={}){
 privateFile(login);need(fs.statSync(root).isDirectory()&&Number.isSafeInteger(deadlineAt),'configuration');
 const directory=dirname(login),pending=join(directory,'codex-credential-intent.json');
 need(!fs.existsSync(pending)&&!fs.existsSync(join(directory,'auth-update-pending.json')),'reconciliation-required');
 let original=bytes(login),held=null,intent=null,launched=false,unresolved=false,settled=false;
 const source=join(root,'source.json'),output=join(root,'updated');
 fs.mkdirSync(output,{mode:0o700});
 const saveIntent=()=>{
  if(intent)return;held.assert();need(!fs.existsSync(pending),'reconciliation-required');
  intent={version:1,execution,original:sha(original),directory:root};write(pending,JSON.stringify(intent));
 };
 const release=async()=>{if(held){await held.release();held=null;}};
 try{
  if(expiry(value(original))<=deadlineAt+120000){held=await lease(directory);privateFile(login);original=bytes(login);saveIntent();}
  write(source,original);
 }catch(e){if(intent&&fs.existsSync(pending)&&JSON.stringify(JSON.parse(bytes(pending)))===JSON.stringify(intent))fs.unlinkSync(pending);await release();throw e;}
 return{
  source,output,markLaunched:()=>{launched=true;},unresolved:()=>unresolved,releaseLease:release,
  async settle({successful=false}={}){
   if(settled)return{status:unresolved?'unresolved':'completed',secrets:[]};
   let secrets=[];
   try{
    if(intent&&!held)held=await lease(directory);
    const entries=fs.readdirSync(output).sort();need(entries.length===0||entries.join(' ')==='auth.json receipt.json','update-inventory');
    if(entries.length){
     if(!held)held=await lease(directory);saveIntent();privateFile(join(output,'auth.json'));privateFile(join(output,'receipt.json'));
     const updated=bytes(join(output,'auth.json')),record=JSON.parse(bytes(join(output,'receipt.json'))),next=value(updated),old=value(original);
     need(Object.keys(record).sort().join(' ')==='original updated version'&&record.version===1&&record.original===sha(original)&&record.updated===sha(updated),'update-receipt');
     secrets=Object.values(next.tokens).filter(v=>typeof v==='string'&&v);
     need(typeof old.tokens.account_id==='string'&&old.tokens.account_id&&next.tokens.account_id===old.tokens.account_id&&expiry(next)>now(),'updated-account');
     held.assert();privateFile(login);need(sha(bytes(login))===sha(original),'current-login-changed');
     // Rename only the validated candidate file. Its original private directory
     // remains available if publication or the parent-directory sync is unknown.
     fs.renameSync(join(output,'auth.json'),login);const d=fs.openSync(directory,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
    }else need(!intent||!launched||successful,'refresh-outcome-unknown');
    if(intent){privateFile(pending);need(JSON.stringify(JSON.parse(bytes(pending)))===JSON.stringify(intent),'intent-drift');fs.unlinkSync(pending);}
    settled=true;return{status:'completed',secrets};
   }catch{unresolved=true;settled=true;return{status:'unresolved',secrets};}
   finally{await release();}
  }
 };
}
