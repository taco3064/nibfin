// Adapted from upstream d1b47d5e073cf15bdcdc1fbbec098401649878d9 verification-prepare; stronger Nibfin input/cache guards retained.
import {lstatSync,realpathSync,readlinkSync,readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,chmodSync,openSync,fstatSync,closeSync,constants,existsSync} from 'node:fs';
import {join,resolve,relative,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJSON,bodyDigest} from './canonical.mjs';
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
  return nodeInputIdentity(root,false);
}
// Copy eligibility excludes old installations and Git metadata. Command inputs do
// not: installed dependencies, executable links and generated fixtures affect tests.
function nodeInputIdentity(root,prepared) {
  directory(root);const files = [], seen = new Set();let bytes = 0;
  const dev = lstatSync(root).dev;
  function walk(path) {
    if (files.length >= 50000) fail('source-limit');
    const s = lstatSync(path), id = `${s.dev}:${s.ino}`;
    if (prepared && s.isSymbolicLink()) {
      // npm's .bin and local-package links are normal. Their targets must remain
      // inside this copy, whose complete physical tree is also hashed below.
      if (!within(root,realpathSync(path))) fail('unsafe-source');
      files.push({path:relative(root,path).split(sep).join('/'),mode:'link',target:readlinkSync(path)});
      return;
    }
    if (s.isSymbolicLink() || s.dev !== dev || seen.has(id) || (!s.isFile() && !s.isDirectory())
        || s.isFile() && s.nlink !== 1) fail('unsafe-source');
    seen.add(id);
    if (s.isDirectory()) {
      if (prepared) files.push({path:relative(root,path).split(sep).join('/'),mode:'directory'});
      for (const name of readdirSync(path).sort()) {
        if (!prepared && ['.git','node_modules'].includes(name)) continue;
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
/** Revalidate a CLI command's prepared cwd; manifest is outside writable source.
 * Hash current installed inputs and cache, never inherit a previous pass. */
export function preparedCommandInputs(cwd,{pathMappings=[]}={}) {
  if(!Array.isArray(pathMappings)||pathMappings.some(m=>!m||Object.keys(m).sort().join(' ')!=='from to'||
    ![m.from,m.to].every(p=>typeof p==='string'&&p!=='/'&&resolve(p)===p)))fail('preparation-path-mapping');
  const mapped=path=>{const m=pathMappings.find(m=>within(m.from,path));return m?m.to+path.slice(m.from.length):path;};
  let cursor=resolve(cwd);
  for(let depth=0;depth<32&&cursor!=='/';depth++,cursor=dirname(cursor)) {
    const manifest=join(cursor,'prepared.json');
    if(!existsSync(manifest)||!existsSync(join(cursor,'source')))continue;
    const stored=JSON.parse(readSafe(manifest));
    const value={...stored,source:mapped(stored.source),directory:mapped(stored.directory),cache:mapped(stored.cache)};
    if(value.version!==1||value.directory!==join(cursor,'source')||value.cache!==join(cursor,'cache')||
      !within(value.directory,resolve(cwd)))fail('preparation-manifest');
    const original=nodeSourceIdentity(value.source);
    if(original.identity!==value.sourceIdentity)fail('stale-copy');
    for(const entry of original.files) {
      const path=join(value.directory,entry.path);
      if(hash(readSafe(path))!==entry.digest||(lstatSync(path).mode&0o111?'executable':'file')!==entry.mode)fail('modified-copy');
    }
    return {source:original.identity,copy:nodeInputIdentity(value.directory,true).identity,cache:nodeInputIdentity(value.cache,true).identity};
  }
  return null;
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
  if (nodeSourceIdentity(source).identity !== before.identity || nodeSourceIdentity(copy).identity !== before.identity) fail('source-changed');
  writeFileSync(join(work,'prepared.json'),JSON.stringify({version:1,source,directory:copy,cache,sourceIdentity:before.identity}),{flag:'wx',mode:0o600});
  // Tests can create cwd fixtures in this writable copy. Original identity is checked on
  // every use; test-created files in the copy do not falsely invalidate original inputs.
  return Object.freeze({status:'prepared',directory:copy,cwd,cache,environment:Object.freeze(env),
    sourceIdentity:before.identity,receipt,
    assertCurrent() {if (nodeSourceIdentity(source).identity !== before.identity) fail('stale-copy');return before.identity;},
    async command({file,args,timeoutMs,inputs={}},{signal,reuse=false}={}) {
      const current = nodeSourceIdentity(source).identity;
      if (current !== before.identity) fail('stale-copy');
      for(const entry of before.files)if(hash(readSafe(join(copy,entry.path)))!==entry.digest || (lstatSync(join(copy,entry.path)).mode&0o111?'executable':'file')!==entry.mode)fail('modified-copy');
      const result=await lane.command({file,args,timeoutMs,cwd,env,inputs:{...inputs,source:current,copy:nodeInputIdentity(copy,true).identity,cache:nodeInputIdentity(cache,true).identity}},{signal,reuse});
      if(nodeSourceIdentity(source).identity!==before.identity)fail('source-changed');
      return result;
    }
  });
}
