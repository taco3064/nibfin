import {lstatSync,realpathSync,readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,chmodSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {join,resolve,relative,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJSON,bodyDigest} from './grants.mjs';
const fail = code => {throw Error(`node-verification:${code}`);};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function readSafe(path) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>128*1024*1024)fail('unsafe-source');return readFileSync(fd);}
  finally {closeSync(fd);}
}
const within = (root,path) => path === root || path.startsWith(root + sep);
function directory(path) {
  if (typeof path !== 'string' || resolve(path) !== path || path === '/' || realpathSync(path) !== path) fail('path');
  for (let p=path;p!=='/';p=dirname(p)) if (lstatSync(p).isSymbolicLink()) fail('path');
  if (!lstatSync(path).isDirectory()) fail('directory');
}
/** The original is inspected, never chmod'ed or written. Links and special files fail closed. */
export function nodeSourceIdentity(root) {
  directory(root);const files = [], seen = new Set();let bytes = 0;
  const dev = lstatSync(root).dev;
  function walk(path) {
    const s = lstatSync(path), id = `${s.dev}:${s.ino}`;
    if (s.isSymbolicLink() || s.dev !== dev || seen.has(id) || (!s.isFile() && !s.isDirectory())
        || s.isFile() && s.nlink !== 1) fail('unsafe-source');
    seen.add(id);
    if (s.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (['.git','node_modules'].includes(name)) continue;
        walk(join(path,name));
      }
    } else {
      bytes += s.size;
      if (files.length >= 50000 || bytes > 128 * 1024 * 1024) fail('source-limit');
      const data = readSafe(path);
      if (data.length !== s.size) fail('source-changed');
      files.push({path:relative(root,path).split(sep).join('/'),mode:s.mode & 0o111 ? 'executable':'file',digest:hash(data)});
    }
  }
  walk(root);
  return Object.freeze({identity:bodyDigest(canonicalJSON(files)),files:Object.freeze(files)});
}
/** Explicitly prepare each required nested project by project path. No workspace discovery,
 * dependency scripts, ambient npm configuration, inherited cache or Candidate fixture writes.
 * Must run INSIDE the selected runtime's enforced dependency-download boundary.
 */
export async function prepareNodeVerification({source,scratch,lane,project='.',
  npm='/usr/bin/npm',path='/usr/local/bin:/usr/bin:/bin',networkEnvironment={}} = {}, {signal} = {}) {
  directory(source);directory(scratch);
  if (within(source,scratch) || within(scratch,source) || !lane?.command || !lane?.budget?.require
      || typeof project !== 'string' || project !== '.' && (!/^[a-zA-Z0-9_./-]+$/.test(project)
        || project.split('/').some(p=>!p || p==='.' || p==='..'))
      || !npm.startsWith('/') || typeof path !== 'string') fail('configuration');
  const allowed = ['HTTPS_PROXY','HTTP_PROXY','NODE_EXTRA_CA_CERTS'];
  if (Object.keys(networkEnvironment).some(k=>!allowed.includes(k))
      || Object.values(networkEnvironment).some(v=>typeof v !== 'string' || /[\x00-\x20]/.test(v))) fail('network-environment');
  lane.budget.require();
  const before = nodeSourceIdentity(source), sourceProject = resolve(source,project);
  if (!within(source,sourceProject)) fail('project');
  if(before.files.some(f=>f.path==='.npmrc'||f.path===project+'/.npmrc'))fail('project-npm-configuration');
  const lock = join(sourceProject,'package-lock.json'), pkg = join(sourceProject,'package.json');
  // Presence is checked against the safe inventory before any copy/dependency operation.
  for (const p of [lock,pkg]) if (!before.files.some(f=>f.path===relative(source,p).split(sep).join('/'))) fail('locked-project');
  const work = mkdtempSync(join(scratch,'nibfin-verification-'));chmodSync(work,0o700);
  const copy = join(work,'source'), cache = join(work,'cache'), home = join(work,'home');
  for (const p of [copy,cache,home]) mkdirSync(p,{mode:0o700});
  for (const f of before.files) {
    lane.budget.require();
    const from = join(source,f.path), to = join(copy,f.path), bytes = readSafe(from);
    if (hash(bytes) !== f.digest || !lstatSync(from).isFile() || lstatSync(from).nlink !== 1) fail('source-changed');
    mkdirSync(dirname(to),{recursive:true,mode:0o700});
    writeFileSync(to,bytes,{flag:'wx',mode:f.mode==='executable'?0o700:0o600});
  }
  if (nodeSourceIdentity(copy).identity !== before.identity || nodeSourceIdentity(source).identity !== before.identity) fail('source-changed');
  const cwd = resolve(copy,project);
  const userConfig=join(home,'user.npmrc'),globalConfig=join(home,'global.npmrc');
  writeFileSync(userConfig,'',{flag:'wx',mode:0o600});writeFileSync(globalConfig,'',{flag:'wx',mode:0o600});
  const env = {PATH:path,HOME:home,LANG:'C',NPM_CONFIG_USERCONFIG:userConfig,NPM_CONFIG_GLOBALCONFIG:globalConfig,
    NPM_CONFIG_CACHE:cache,NPM_CONFIG_REGISTRY:'https://registry.npmjs.org',NPM_CONFIG_IGNORE_SCRIPTS:'true',
    NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',...networkEnvironment};
  const receipt = await lane.command({file:npm,args:['ci','--ignore-scripts','--no-audit','--no-fund',
    '--registry=https://registry.npmjs.org','--cache',cache],cwd,env,timeoutMs:lane.budget.require(),
    inputs:{source:before.identity,lock:hash(readFileSync(lock)),package:hash(readFileSync(pkg))}},{signal});
  if (receipt.status !== 'passed') return Object.freeze({status:'failed',diagnostic:'dependency-preparation',receipt,
    directory:copy,cache,sourceIdentity:before.identity});
  if (nodeSourceIdentity(source).identity !== before.identity) fail('source-changed');
  // Tests can create cwd fixtures in this writable copy. Original identity is checked on
  // every use; test-created files in the copy do not falsely invalidate original inputs.
  return Object.freeze({status:'prepared',directory:copy,cwd,cache,environment:Object.freeze(env),
    sourceIdentity:before.identity,receipt,
    assertCurrent() {if (nodeSourceIdentity(source).identity !== before.identity) fail('stale-copy');return before.identity;},
    async command({file,args,timeoutMs,inputs={}},{signal,reuse=false}={}) {
      const current = nodeSourceIdentity(source).identity;
      if (current !== before.identity) fail('stale-copy');
      for(const entry of before.files)if(hash(readSafe(join(copy,entry.path)))!==entry.digest)fail('modified-copy');
      const result=await lane.command({file,args,timeoutMs,cwd,env,inputs:{...inputs,source:current,copy:nodeSourceIdentity(copy).identity}},{signal,reuse});
      if(nodeSourceIdentity(source).identity!==before.identity)fail('source-changed');
      return result;
    }
  });
}
