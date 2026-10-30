import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {constants, lstatSync, openSync, closeSync, fstatSync, readSync, mkdtempSync, rmSync,
  existsSync,readdirSync,mkdirSync,writeFileSync,renameSync,readFileSync,chmodSync} from 'node:fs';
import {resolve, join, parse,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {canonicalJSON, bodyDigest} from './grants.mjs';
import {byteDigest, contentIdentity} from './evidence.mjs';
import {sourceManifest} from './workspace-sources.mjs';
import {parseCandidateObligations, safeObligationPath} from './obligations.mjs';

const fail = reason => { throw new TypeError(`workspace:${reason}`); };
const clone = value => JSON.parse(canonicalJSON(value));
const equal = (a,b) => { if (canonicalJSON(a) !== canonicalJSON(b)) fail('mismatch'); };
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const gitIdentity = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
export const workspaceLimits = Object.freeze({entries:10000, payloadBytes:8*1024*1024,
  totalBytes:32*1024*1024, serializedBytes:48*1024*1024});
function limits(input = {}) {
  const v = {...workspaceLimits, ...input};
  if (Object.keys(v).some(k => !Object.hasOwn(workspaceLimits,k))
      || Object.values(v).some(n => !Number.isSafeInteger(n) || n < 1)) fail('limits');
  return v;
}
function exact(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) fail('schema');
  equal(Object.keys(v).sort(),keys.split(' ').sort());
}
function path(p) {
  if (!safeObligationPath(p) || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(p)
      || p.split('/').some(s => s.toLowerCase() === '.git')) fail('path');
}
function boundary(paths) {
  if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length) fail('boundary');
  paths.forEach(path);
}
function permitted(p, paths) {
  path(p);
  if (!paths.some(prefix => p === prefix || p.startsWith(prefix + '/'))) fail('boundary');
}
function bindings(v) {
  exact(v,'repository scopeHash shapeHash cycle policy');
  if (typeof v.repository !== 'string' || !v.repository.trim() || typeof v.cycle !== 'string' || !v.cycle.trim()
      || !hash(v.scopeHash) || !hash(v.shapeHash) || !hash(v.policy)) fail('binding');
}
// Inherit only executable lookup. In particular no alternate object/index/config,
// credentials, external diff, pager or replacement objects from the caller env.
function git(root,args,max,input,gitDirectory) {
  return execFileSync('git', [...(gitDirectory?['--git-dir='+gitDirectory,'--work-tree='+root]:[]),'--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','diff.external=','-c','credential.helper=','-c','core.attributesFile=/dev/null',...args], {cwd:root,
    env:{PATH:process.env.PATH, HOME:'/nonexistent', GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_OPTIONAL_LOCKS:'0',
      GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'},
    input, timeout:30000, maxBuffer:max, stdio:['pipe','pipe','pipe']});
}
function text(bytes) {
  const s = bytes.toString('utf8');
  if (!Buffer.from(s).equals(bytes)) fail('filename-encoding');
  return s;
}
function records(bytes) {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) fail('git-record');
  return text(bytes).slice(0,-1).split('\0');
}
function safeRead(root,p,l) {
  const target = resolve(root,p);
  let current = parse(target).root;
  for (const part of target.slice(current.length).split('/').filter(Boolean)) {
    current = join(current,part);
    if (lstatSync(current).isSymbolicLink()) fail('symlink');
  }
  const fd = openSync(target,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !(before.mode & 0o444) || before.size > l.payloadBytes) fail('source-type-size');
    const storage=Buffer.alloc(before.size+1);let length=0;
    while(length<storage.length) {
      const n=readSync(fd,storage,length,storage.length-length,null);
      if(!n) break;length+=n;
    }
    const bytes=storage.subarray(0,length);
    const after = fstatSync(fd), named = lstatSync(target);
    if (bytes.length !== before.size || bytes.length > l.payloadBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || before.ino !== named.ino || before.dev !== named.dev
        || named.isSymbolicLink()) fail('inconsistent-read');
    return {bytes, mode:(before.mode & 0o111) ? '100755' : '100644'};
  } finally {closeSync(fd);}
}
function budget(entries,l) {
  if (entries.length > l.entries) fail('entry-limit');
  let size=0;
  for (const e of entries) {
    if (e.bytes.length > l.payloadBytes) fail('payload-limit');
    size += e.bytes.length;
    if (size > l.totalBytes) fail('total-limit');
  }
}
function inventory(body) {
  const parsed = parseCandidateObligations(body);
  if (!parsed.ok) fail('inventory');
  for (const e of [...parsed.inventory.artifacts,...parsed.inventory.hooks]) path(e.path);
  return parsed;
}
function treeEntries(bytes) {
  const entries=[]; let at=0;
  while(at < bytes.length) {
    const space=bytes.indexOf(32,at), zero=bytes.indexOf(0,space+1);
    if (space < at || zero < space || zero+21 > bytes.length) fail('tree');
    const mode=text(bytes.subarray(at,space)), name=text(bytes.subarray(space+1,zero));
    path(name); if (name.includes('/') || !['100644','100755','40000'].includes(mode)) fail('git-type');
    entries.push({mode,name,oid:bytes.subarray(zero+1,zero+21).toString('hex')}); at=zero+21;
  }
  const sorted=[...entries].sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.mode==='40000'?'/':'')),Buffer.from(b.name+(b.mode==='40000'?'/':''))));
  equal(entries,sorted);
  if (new Set(entries.map(e=>e.name)).size !== entries.length) fail('duplicate');
  return entries;
}
function flatten(tree, objects, paths, prefix='', used=new Set(), depth=0, max=workspaceLimits.entries, count={n:0}) {
  if (depth > 64) fail('tree-depth');
  const item=objects.get(tree);
  if (!item || item.type !== 'tree') fail('missing-tree');
  used.add(tree);
  const out=[];
  for (const e of treeEntries(item.bytes)) {
    if(++count.n>max) fail('entry-limit');
    const p=prefix+e.name;
    if(e.mode==='40000') out.push(...flatten(e.oid,objects,paths,p+'/',used,depth+1,max,count));
    else {
      permitted(p,paths);
      const blob=objects.get(e.oid);
      if (!blob || blob.type !== 'blob') fail('missing-blob');
      used.add(e.oid); out.push({path:p,mode:e.mode,oid:e.oid});
    }
  }
  return out.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
function makeTree(files,put,prefix='') {
  const children=new Map();
  for (const f of files) {
    const tail=f.path.slice(prefix.length), slash=tail.indexOf('/');
    const name=slash < 0 ? tail : tail.slice(0,slash);
    if (!children.has(name)) children.set(name,[]);
    children.get(name).push(f);
  }
  const entries=[];
  for (const [name,group] of children) {
    if (group[0].path===prefix+name) {
      if(group.length!==1) fail('path-collision');
      entries.push({name,mode:group[0].mode,oid:group[0].oid});
    } else entries.push({name,mode:'40000',oid:makeTree(group,put,prefix+name+'/')});
  }
  entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.mode==='40000'?'/':'')),Buffer.from(b.name+(b.mode==='40000'?'/':''))));
  return put('tree',Buffer.concat(entries.flatMap(e=>[Buffer.from(`${e.mode} ${e.name}\0`),Buffer.from(e.oid,'hex')])));
}
function changes(base,proposed) {
  const a=new Map(base.map(e=>[e.path,e])), b=new Map(proposed.map(e=>[e.path,e]));
  return [...new Set([...a.keys(),...b.keys()])].sort().filter(p=>canonicalJSON(a.get(p)??null)!==canonicalJSON(b.get(p)??null))
    .map(p=>({path:p,before:a.get(p)??null,after:b.get(p)??null}));
}
function computeDiff(objects,baseTree,tree,l) {
  const root=mkdtempSync(join(tmpdir(),'nibfin-diff-'));
  try {
    git(root,['init','--bare','--template=','--object-format=sha1','.'],l.serializedBytes);
    for (const e of objects.values()) {
      const actual=git(root,['hash-object','-w','-t',e.type,'--stdin'],l.serializedBytes,e.bytes).toString().trim();
      if(actual!==e.oid) fail('object');
    }
    return git(root,['diff-tree','--no-commit-id','--no-ext-diff','--no-textconv','--no-renames',
      '--binary','--full-index','--no-color','-p',baseTree,tree,'--'],l.serializedBytes);
  } finally {rmSync(root,{recursive:true,force:true});}
}
function descriptor(m,objects,diff,sources) {
  const manifest=sourceManifest(sources);
  const candidate={base:m.base,tree:m.tree,diff:byteDigest(diff),paths:m.changes.map(e=>e.path),
    artifacts:manifest.filter(e=>e.kind==='artifact').map(e=>({path:e.path,digest:e.sha256})),
    hooks:manifest.filter(e=>e.kind==='hook').map(e=>({path:e.path,event:e.event,digest:e.sha256})),
    emptyHooksReason:m.emptyHooksReason};
  const identity=contentIdentity({kind:'nibfin-workspace-v1',metadata:m,candidate,
    objects:[...objects.values()].map(e=>({oid:e.oid,type:e.type,size:e.bytes.length,digest:byteDigest(e.bytes)})),
    sources:sources.map(({bytes,...e})=>({...e,digest:byteDigest(bytes)}))});
  return {identity,binding:clone(m.binding),candidate};
}
const captures=new WeakMap();
function retain(m,objects,diff,sources) {
  const expected=descriptor(m,objects,diff,sources);
  const handle=Object.freeze({get expected(){return clone(expected);},get metadata(){return clone(m);},
    get candidate(){return clone(expected.candidate);},get diff(){return Buffer.from(diff);},
    get objects(){return [...objects.values()].map(e=>({...e,bytes:Buffer.from(e.bytes)}));},
    get sources(){return sources.map(e=>({...e,bytes:Buffer.from(e.bytes)}));}});
  captures.set(handle,{m,objects,diff,sources,expected}); return handle;
}
/** Capture final worktree bytes, regardless of partial staging, without altering the real index. */
export function captureWorkspace(input) {
  const {root,base,scopeBody,shapeBody}=input;
  const binding=clone(input.binding), permittedPaths=clone(input.permittedPaths), l=limits(input.limits);
  bindings(binding); boundary(permittedPaths);
  if (!oid(base) || typeof root !== 'string') fail('base-root');
  const parsed=inventory(shapeBody);
  // Existing Core body hash semantics, not raw UTF-8 hashing.
  if (typeof scopeBody!=='string' || bodyDigest(scopeBody)!==binding.scopeHash || bodyDigest(shapeBody)!==binding.shapeHash) fail('body');
  const absolute=resolve(root);
  const gitDirectory=input.gitDirectory;
  if(gitDirectory!==undefined){
    if(typeof gitDirectory!=='string'||resolve(gitDirectory)!==gitDirectory||gitDirectory==='/')fail('git-directory');
    for(let p=gitDirectory;;p=dirname(p)){
      const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())fail('git-directory');if(p==='/')break;
    }
  }
  const run=args=>git(absolute,args,l.serializedBytes,undefined,gitDirectory);
  if(run(['rev-parse','--show-object-format']).toString().trim()!=='sha1'
      || run(['rev-parse','--show-toplevel']).toString().trim()!==absolute) fail('repository');
  const objects=new Map();
  const put=(type,bytes)=>{
    const id=gitIdentity(type,bytes);
    objects.set(id,{oid:id,type,bytes:Buffer.from(bytes)}); budget([...objects.values()],l); return id;
  };
  const load=(id,type,depth=0)=>{
    if(objects.has(id)) return;
    if(depth>64) fail('tree-depth');
    const size=Number(run(['cat-file','-s',id]).toString());
    if(!Number.isSafeInteger(size) || size<0 || size>l.payloadBytes) fail('payload-limit');
    const bytes=run(['cat-file',type,id]);
    if(put(type,bytes)!==id) fail('object');
    if(type==='tree') for(const e of treeEntries(bytes)) load(e.oid,e.mode==='40000'?'tree':'blob',depth+1);
  };
  load(base,'commit');
  const commit=objects.get(base).bytes;
  const baseTree=/^tree ([a-f0-9]{40})\n/.exec(commit.toString())?.[1];
  if(!baseTree) fail('commit');
  load(baseTree,'tree');
  const baseFiles=flatten(baseTree,objects,permittedPaths,'',new Set(),0,l.entries);
  const observedHead=()=>{
    try{return run(['rev-parse','--verify','--quiet','HEAD']).toString();}
    catch(error){
      if(error.status!==1||error.stdout?.length||error.stderr?.length)throw error;
      const ref=run(['symbolic-ref','-q','HEAD']).toString().trim();
      if(!ref.startsWith('refs/heads/')||/[\x00-\x20\x7f]/.test(ref))fail('head');
      return 'unborn:'+ref;
    }
  };
  const state=()=>{
    const index=run(['ls-files','--stage','-z']);
    for(const record of records(index)) {
      const match=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(record);
      if(!match) fail('index-entry-type-stage');
      permitted(match[3],permittedPaths);
    }
    const names=records(run(['ls-files','--cached','--others','--exclude-standard','-z']));
    if(names.length>l.entries) fail('entry-limit');
    return {head:observedHead(),index:index.toString('base64'),names};
  };
  const first=state();
  const observe=()=>{
    const files=[];
    for(const p of [...new Set(state().names)].sort()) {
      permitted(p,permittedPaths);
      let read;
      try {read=safeRead(absolute,p,l);} catch(e) {if(e.code==='ENOENT') continue;throw e;}
      files.push({path:p,mode:read.mode,oid:put('blob',read.bytes)});
    }
    const sources=[];
    for(const [kind,entries] of [['artifact',parsed.inventory.artifacts],['hook',parsed.inventory.hooks]]) {
      for(const e of entries) {
        permitted(e.path,permittedPaths);
        const read=safeRead(absolute,e.path,l);
        sources.push({kind,...e,mode:read.mode,bytes:read.bytes});
      }
    }
    budget([...objects.values(),...sources],l);
    return {files,sources};
  };
  const a=observe(), tree=makeTree(a.files,put);
  // Deterministic observation seam for trusted local callers/tests; never execute repository sources.
  if(input.afterRead!==undefined) {if(typeof input.afterRead!=='function') fail('observer');input.afterRead();}
  const b=observe();
  equal(a.files,b.files); equal(a.sources.map(e=>({...e,bytes:e.bytes.toString('base64')})),b.sources.map(e=>({...e,bytes:e.bytes.toString('base64')})));
  equal(first,state());
  const used=new Set([base]);flatten(baseTree,objects,permittedPaths,'',used,0,l.entries);flatten(tree,objects,permittedPaths,'',used,0,l.entries);
  for(const id of objects.keys()) if(!used.has(id)) objects.delete(id);
  const ordered=new Map([...objects].sort(([a],[b])=>a.localeCompare(b)));
  const diff=computeDiff(ordered,baseTree,tree,l);
  // Check again after scratch Git work, including every ignored declaration.
  const final=observe();equal(a.files,final.files);
  equal(a.sources.map(e=>({...e,bytes:e.bytes.toString('base64')})),
    final.sources.map(e=>({...e,bytes:e.bytes.toString('base64')})));
  equal(first,state());
  const m={version:1,binding,base,baseTree,tree,permittedPaths,changes:changes(baseFiles,a.files),
    inventory:parsed.inventory,emptyHooksReason:parsed.inventory.hooks.length?null:parsed.explanations.hooks};
  const handle=retain(m,ordered,diff,a.sources);
  // Enforce output bound before exposing a successful capture.
  exportWorkspace(handle,{limits:l});return handle;
}
export function verifyWorkspace(capture,expected) {
  const data=captures.get(capture);
  if(!data || !expected) fail('protected-expectations');
  exact(expected,'identity binding candidate'); bindings(expected.binding);
  equal(data.expected,expected);return capture.expected;
}
export function exportWorkspace(capture,{limits:input}={}) {
  const d=captures.get(capture);if(!d) fail('capture');const l=limits(input);
  budget([...d.objects.values(),...d.sources,{bytes:d.diff}],l);
  const wire={version:1,metadata:d.m,objects:[...d.objects.values()].map(({bytes,...e})=>({...e,data:bytes.toString('base64')})),
    sources:d.sources.map(({bytes,...e})=>({...e,data:bytes.toString('base64')})),diff:d.diff.toString('base64')};
  // Bound the predictable base64 expansion before serialization.
  const estimated=Buffer.byteLength(canonicalJSON({...wire,objects:wire.objects.map(e=>({...e,data:''})),
    sources:wire.sources.map(e=>({...e,data:''})),diff:''}))
    +wire.objects.reduce((n,e)=>n+e.data.length,0)+wire.sources.reduce((n,e)=>n+e.data.length,0)+wire.diff.length;
  if(estimated>l.serializedBytes) fail('serialized-limit');
  const out=Buffer.from(canonicalJSON(wire));if(out.length>l.serializedBytes) fail('serialized-limit');return out;
}
export function importWorkspace(input,{expected,limits:bounds}={}) {
  const l=limits(bounds);
  if(!(input instanceof Uint8Array) || input.byteLength>l.serializedBytes) fail('serialized-limit');
  const wire=JSON.parse(Buffer.from(input).toString('utf8'));
  // Canonical encoding rejects duplicate JSON keys, ignored whitespace and invalid UTF-8.
  if(!Buffer.from(canonicalJSON(wire)).equals(Buffer.from(input))) fail('encoding');
  exact(wire,'version metadata objects sources diff');
  if(wire.version!==1) fail('version');
  const m=wire.metadata;
  exact(m,'version binding base baseTree tree permittedPaths changes inventory emptyHooksReason');
  if(m.version!==1 || !oid(m.base) || !oid(m.baseTree) || !oid(m.tree)) fail('metadata');
  bindings(m.binding);boundary(m.permittedPaths);
  if(!Array.isArray(wire.objects) || !Array.isArray(wire.sources)
      || wire.objects.length+wire.sources.length+1>l.entries) fail('entry-limit');
  let total=0;
  const decode=s=>{
    if(typeof s!=='string' || s.length>4*Math.ceil(l.payloadBytes/3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) fail('base64');
    const n=s.length/4*3-(s.endsWith('==')?2:s.endsWith('=')?1:0);
    if(n>l.payloadBytes || (total+=n)>l.totalBytes) fail('payload-total-limit');
    const b=Buffer.from(s,'base64');if(b.toString('base64')!==s) fail('base64');return b;
  };
  const objects=new Map();let last='';
  for(const e of wire.objects) {
    exact(e,'oid type data');
    if(!oid(e.oid) || e.oid<=last || !['commit','tree','blob'].includes(e.type)) fail('object');last=e.oid;
    const bytes=decode(e.data);if(gitIdentity(e.type,bytes)!==e.oid) fail('corrupt');
    objects.set(e.oid,{oid:e.oid,type:e.type,bytes});
  }
  const commit=objects.get(m.base);
  if(commit?.type!=='commit' || !commit.bytes.toString().startsWith(`tree ${m.baseTree}\n`)) fail('base');
  const used=new Set([m.base]);
  const baseFiles=flatten(m.baseTree,objects,m.permittedPaths,'',used,0,l.entries), files=flatten(m.tree,objects,m.permittedPaths,'',used,0,l.entries);
  if(used.size!==objects.size) fail('extra-object');
  equal(m.changes,changes(baseFiles,files));
  const parsed=inventory(['Candidate artifacts applicability: Transfer declarations.',
    `Candidate hooks applicability: ${m.emptyHooksReason??'Declared hooks.'}`,'```nibfin-candidate',JSON.stringify(m.inventory),'```'].join('\n'));
  if(m.inventory.hooks.length ? m.emptyHooksReason!==null :
      typeof m.emptyHooksReason!=='string' || !m.emptyHooksReason.trim() || /[\x00-\x1f]/.test(m.emptyHooksReason)) fail('applicability');
  const declarations=[...parsed.inventory.artifacts.map(e=>({kind:'artifact',...e})),...parsed.inventory.hooks.map(e=>({kind:'hook',...e}))];
  if(declarations.length!==wire.sources.length) fail('sources');
  const sources=wire.sources.map((e,i)=>{
    exact(e,declarations[i].kind==='artifact'?'kind path purpose mode data':'kind path event mode data');
    const {data,mode,...declaration}=e;equal(declaration,declarations[i]);
    permitted(e.path,m.permittedPaths);if(!['100644','100755'].includes(mode)) fail('mode');
    return {...declaration,mode,bytes:decode(data)};
  });
  const diff=decode(wire.diff);
  if(!computeDiff(objects,m.baseTree,m.tree,l).equals(diff)) fail('diff');
  const handle=retain(m,objects,diff,sources);verifyWorkspace(handle,expected);return handle;
}

/** Materialize an independently verified transfer into a new private role
 * checkout. No fetch, checkout filters, repository scripts or hooks execute.
 * Existing work is never overwritten. A private staging tree is fully built
 * before its atomic publication at the selected empty/nonexistent destination.
 * This is a filesystem transfer receipt, never an Acceptance verdict. */
export function materializeWorkspace(capture,{expected,root}={}) {
  verifyWorkspace(capture,expected);const data=captures.get(capture),l=workspaceLimits;
  if(process.platform!=='linux'||typeof root!=='string'||resolve(root)!==root||root==='/'
    ||root.split('/').some(p=>p.toLowerCase()==='.git')||/[\x00-\x20]/.test(root))fail('materialize-root');
  for(let cursor=dirname(root);;cursor=dirname(cursor)){
    const s=lstatSync(cursor);if(!s.isDirectory()||s.isSymbolicLink())fail('materialize-parent');
    if(cursor===dirname(root)&&(s.uid!==process.getuid()||(s.mode&0o077)))fail('materialize-parent');
    if(cursor==='/')break;
  }
  const emptyDestination=()=>{
    let s;try{s=lstatSync(root);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid()
      ||(s.mode&0o077)||readdirSync(root).length)fail('materialize-existing-work');
  };
  emptyDestination();
  let staging=mkdtempSync(join(dirname(root),'.nibfin-materialize-'));
  try{
    git(staging,['init','--template=','--object-format=sha1','.'],l.serializedBytes);
    for(const object of data.objects.values()){
      if(git(staging,['hash-object','-w','-t',object.type,'--stdin'],l.serializedBytes,object.bytes).toString().trim()!==object.oid)fail('materialize-object');
    }
    writeFileSync(join(staging,'.git/shallow'),data.m.base+'\n',{flag:'wx',mode:0o600});
    git(staging,['update-ref','HEAD',data.m.base],l.serializedBytes);
    git(staging,['read-tree',data.m.tree],l.serializedBytes);
    const files=flatten(data.m.tree,data.objects,data.m.permittedPaths);
    const put=(name,mode,bytes)=>{
      const target=join(staging,name);mkdirSync(dirname(target),{recursive:true,mode:0o700});
      if(existsSync(target)){
        const s=lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||!readFileSync(target).equals(bytes)
          ||(s.mode&0o777)!==(mode==='100755'?0o755:0o644))fail('materialize-source-conflict');
      }else {writeFileSync(target,bytes,{flag:'wx',mode:mode==='100755'?0o755:0o644});chmodSync(target,mode==='100755'?0o755:0o644);}
    };
    for(const file of files)put(file.path,file.mode,data.objects.get(file.oid).bytes);
    for(const source of data.sources)put(source.path,source.mode,source.bytes);
    if(git(staging,['rev-parse','HEAD'],l.serializedBytes).toString().trim()!==data.m.base
      ||git(staging,['write-tree'],l.serializedBytes).toString().trim()!==data.m.tree)fail('materialize-git');
    emptyDestination();renameSync(staging,root);staging=null;
    return Object.freeze({version:1,status:'materialized',root,workspace:clone(expected)});
  }finally{if(staging)rmSync(staging,{recursive:true,force:true});}
}
