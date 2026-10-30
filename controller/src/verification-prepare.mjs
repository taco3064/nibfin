// Credential-free preparation inside the Agent's existing isolation and egress.
import {lstat,readdir,readFile,mkdir,mkdtemp,writeFile,chmod,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve,join,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const excluded=new Set(['.git','node_modules']);
const inside=(root,path)=>path===root||path.startsWith(root+sep);
export async function sourceFiles(source,{maxFiles=50000,maxBytes=268435456}={}) {
 const root=await realpath(source),files=[];let total=0;
 if(root!==resolve(source))throw Error('verification preparation: source alias');
 async function walk(dir){for(const name of (await readdir(dir)).sort()){
  if(excluded.has(name))continue;
  const path=join(dir,name),s=await lstat(path);
  if(s.isSymbolicLink()||!s.isDirectory()&&!s.isFile()||s.isFile()&&s.nlink!==1)throw Error('verification preparation: unsafe source entry');
  if(s.isDirectory()){await walk(path);continue;}
  if(files.length>=maxFiles||(total+=s.size)>maxBytes)throw Error('verification preparation: source bound exceeded');
  const bytes=await readFile(path);if(bytes.length!==s.size)throw Error('verification preparation: changing source');
  files.push({path:relative(root,path),sha256:hash(bytes),bytes:bytes.length,mode:s.mode&0o777});
 }}
 await walk(root);return {root,files,digest:hash(JSON.stringify(files))};
}
async function verifyFiles(root,files){for(const file of files){const path=join(root,file.path),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o777)!==file.mode||hash(await readFile(path))!==file.sha256)throw Error('verification preparation: copied source changed');}}
export function installNodeDependencies(directory,{env=process.env}={}) {
 return new Promise((resolveRun,reject)=>{
  const child=spawn('npm',['ci','--ignore-scripts','--no-bin-links','--no-audit','--no-fund'],{cwd:directory,env,shell:false,stdio:['ignore','inherit','inherit']});
  child.once('error',()=>reject(Error('verification preparation: npm unavailable')));
  child.once('close',code=>code===0?resolveRun():reject(Error('verification preparation: dependency preparation failed; inspect guarded log for registry/cache/auth/network diagnostics')));
 });
}
export async function prepareNodeVerification({source='/work',scratch='/tmp',install=installNodeDependencies}={}) {
 source=resolve(source);scratch=resolve(scratch);
 if(inside(source,scratch)||inside(scratch,source))throw Error('verification preparation: source and scratch must be separate');
 if(await realpath(scratch)!==scratch||!(await lstat(scratch)).isDirectory())throw Error('verification preparation: scratch alias');
 const original=await sourceFiles(source);
 if(!original.files.some(f=>f.path==='package.json')||!original.files.some(f=>f.path==='package-lock.json'))throw Error('verification preparation: locked npm project required');
 const directory=await mkdtemp(join(scratch,'nibfin-node-verification-'));
 for(const file of original.files){const target=join(directory,file.path);await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,await readFile(join(source,file.path)),{flag:'wx',mode:file.mode});await chmod(target,file.mode);}
 await verifyFiles(directory,original.files);
 await install(directory);
 await verifyFiles(directory,original.files);
 const after=await sourceFiles(source);if(after.digest!==original.digest)throw Error('verification preparation: source changed during preparation');
 const receipt={schemaVersion:1,status:'prepared',directory,source,sourceDigest:original.digest,files:original.files.length,dependencyScripts:false,sourceUnchanged:true,evidenceBoundary:'Prepared writable test input only; no test, Acceptance or CI success is implied.'};
 await writeFile(join(directory,'.nibfin-verification-preparation.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});return receipt;
}
export async function main(args=process.argv.slice(2)) {
 if(args.length>2)throw Error('Usage: node /verification-prepare.mjs [source=/work] [scratch=/tmp]');
 const lane=JSON.parse(await readFile('/io/verification/active.lock','utf8'));
 if(lane.pid!==process.ppid)throw Error('verification preparation: invoke through the verification runner');
 console.log(JSON.stringify(await prepareNodeVerification({source:args[0]||'/work',scratch:args[1]||'/tmp'})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
