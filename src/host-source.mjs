import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';

export const protectedHostFiles=Object.freeze(['host/entry.mjs','host/package.json','host/package-lock.json',
  'host/configuration.schema.json','host/configuration.example.json']);
const need = ok => {if(!ok)throw Error('protected-host:source');};
const hash = b => createHash('sha256').update(b).digest('hex');
const fields=(v,keys)=>need(v && typeof v==='object' && !Array.isArray(v)
  && JSON.stringify(Object.keys(v).sort())===JSON.stringify(keys.slice().sort()));
const pathOK=p=>typeof p==='string' && p.length<512 && !p.includes('\\') && !isAbsolute(p)
  && p.split('/').every(s=>/^[A-Za-z0-9_.-]+$/.test(s) && s!=='.' && s!=='..' && s!=='.git' && s!=='node_modules');
const repoOK=v=>typeof v==='string' && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(v)
  && !v.split('/')[0].includes('--') && !['.','..'].includes(v.split('/')[1]);
/** Verify every path component, rejecting symlinks even when they point inside root. */
async function containedFile(root,path) {
  need(pathOK(path));
  let cursor=root;
  for (const part of path.split('/')) {
    cursor=join(cursor,part);const stat=await lstat(cursor);
    need(!stat.isSymbolicLink());
    need(cursor===join(root,path)?stat.isFile():stat.isDirectory());
  }
  const actual=await realpath(cursor),rel=relative(root,actual);
  need(rel!=='' && !rel.startsWith('..'+sep) && !isAbsolute(rel));
  return readFile(cursor);
}
/** The approval is a trusted protected-Environment snapshot, not a checkout manifest.
 * The caller fixes allowedRoot and independently supplies repository/commit observations.
 * This does not authenticate its own caller/bundle bootstrap or a Git checkout.
 */
export async function verifyApprovedSource({root,allowedRoot,repository,commit,approval,required=[]}) {
  try {
    need(typeof root==='string' && isAbsolute(root) && root===resolve(allowedRoot));
    // Check ancestors too: a symlinked checkout parent is not a trusted location.
    let cursor=resolve(root);
    while(true){need(!(await lstat(cursor)).isSymbolicLink());const parent=resolve(cursor,'..');if(parent===cursor)break;cursor=parent;}
    need(await realpath(root)===root);
    fields(approval,['repository','commit','files']);
    need(repoOK(repository) && approval.repository===repository && /^[a-f0-9]{40}$/.test(commit??'') && approval.commit===commit);
    need(Array.isArray(approval.files) && approval.files.length>0 && approval.files.length<=1024);
    const bytes=new Map();
    for(const item of approval.files) {
      fields(item,['path','sha256']);need(pathOK(item.path) && !bytes.has(item.path) && /^[a-f0-9]{64}$/.test(item.sha256));
      const value=await containedFile(root,item.path);need(hash(value)===item.sha256);bytes.set(item.path,value);
    }
    need(required.every(p=>bytes.has(p)));
    return bytes;
  } catch {throw Error('protected-host:source');}
}
/** Load the maintained dependency-free entry only after BOTH approvals pass.
 * Local executable/configuration inputs are fixed by the package contract; the
 * maintained entry has no import graph, external modules or dependency resolution.
 */
export async function loadProtectedHost(configuration) {
  try {
    fields(configuration,['bundle','host']);
    const {bundle,host}=configuration;
    for(const source of [bundle,host]) fields(source,['root','allowedRoot','repository','commit','approval']);
    const b=await verifyApprovedSource({...bundle,required:['package.json','package-lock.json','src/index.mjs','src/workflow-entry.mjs','src/host-source.mjs']});
    const manifest=JSON.parse(b.get('package.json'));
    need(Array.isArray(manifest.files) && ['README.md',...manifest.files].every(p=>b.has(p)));
    const h=await verifyApprovedSource({...host,required:protectedHostFiles});
    // Only maintained, dependency-free entry layout is supported by this loader.
    need(host.repository==='taco3064/nibfin');
    const pkg=JSON.parse(h.get('host/package.json')),lock=JSON.parse(h.get('host/package-lock.json'));
    need(pkg.name==='@nibfin/protected-host' && pkg.exports==='./entry.mjs' && !pkg.dependencies && !pkg.devDependencies
      && !pkg.optionalDependencies && !pkg.scripts && lock.lockfileVersion===3
      && lock.name===pkg.name && lock.version===pkg.version && Object.keys(lock.packages).join()==='');
    // Evaluate the already verified bytes, avoiding a path reread/import race or
    // stale module cache on later calls. This entry deliberately has no imports.
    const entry=await import('data:text/javascript;base64,'+h.get('host/entry.mjs').toString('base64'));
    need(typeof entry.configure==='function');
    return entry;
  } catch {throw Error('protected-host:source');}
}

/** Executable deployment bindings are reviewed protected configuration, never event data.
 * Check both the exact options and executable bytes before module evaluation. The
 * module exports functions, not a factory invoked during host construction.
 */
export async function loadProtectedDeployment({source,options,approval,validate,mode}) {
  try {
    fields(approval,['sourceSha256','optionsSha256']);
    need(typeof source==='string' && source.length>0 && source.length<=131072 && typeof options==='string' && options.length<=16384);
    need(hash(source)===approval.sourceSha256 && hash(options)===approval.optionsSha256);
    const configured=JSON.parse(options),member=['execute','compute'].includes(mode);
    const allowed=member?['execute','compute']:['lookup','resolve','wake','registration'];
    need(configured && Object.getPrototypeOf(configured)===Object.prototype && Object.hasOwn(configured,mode));
    const modes=Object.keys(configured);need(modes.length>0 && modes.every(m=>allowed.includes(m)));
    const parsed=Object.fromEntries(modes.map(m=>[m,validate(configured[m],m)]));
    const binding=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    need(Object.keys(binding).every(k=>['capabilities','identity'].includes(k)) && binding.capabilities);
    if(binding.identity)fields(binding.identity,modes.filter(m=>parsed[m].authentication==='actions-oidc'));
    fields(binding.capabilities,modes);
    need(Object.getPrototypeOf(binding.capabilities)===Object.prototype
      && Object.values(Object.getOwnPropertyDescriptors(binding.capabilities)).every(d=>Object.hasOwn(d,'value')));
    return {options:parsed[mode],capabilities:binding.capabilities[mode],
      ...(parsed[mode].authentication==='actions-oidc'?{identity:binding.identity?.[mode]}:{})};
  } catch {throw Error('protected-host:configuration');}
}
