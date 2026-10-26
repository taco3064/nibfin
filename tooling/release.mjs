import {readFileSync,writeFileSync,mkdirSync,lstatSync,readdirSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {packageFiles,verifyArchive,consumeArchive} from './archive.mjs';
import {releaseHash,releaseVersion,releaseComponents,configuration,verifyRelease} from '../src/release.mjs';
export function releaseInputs(root=process.cwd()) {
  const maintained=['test','test-sdk','tooling'].flatMap(dir=>readdirSync(join(root,dir)).filter(n=>n.endsWith('.mjs')).map(n=>dir+'/'+n));
  return [...new Set([...packageFiles,...maintained,'package-lock.json','.github/workflows/core-release.yml'])].sort();
}
export function sourceBinding({root=process.cwd(),base,mergedCommit=null}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || (mergedCommit !== null && !/^[a-f0-9]{40}$/.test(mergedCommit))) throw Error('release:source-input');
  const inputs = releaseInputs(root).map(path => {
    if (!lstatSync(join(root,path)).isFile() || lstatSync(join(root,path)).isSymbolicLink()) throw Error('release:unsafe-source');
    return {path,sha256:releaseHash(readFileSync(join(root,path)))};
  });
  return {kind:mergedCommit ? 'merged':'candidate',base,commit:mergedCommit,inputs,contentSha256:releaseHash(JSON.stringify(inputs))};
}
export function initialCompatibility(components,read=path=>readFileSync(path)) {
  const entries=[];
  const add = (id, extra) => entries.push({id,agent:'unknown',agentVersion:'unknown',hostOS:'unknown',hostArch:'unknown',
    guestOS:'unknown',guestArch:'unknown',authentication:'unknown',isolation:'unknown',ownership:'any',visibility:'public',
    registration:'unknown',automaticRegistration:'unknown',capability:'product-delivery',status:'Unverified',
    limitations:'No measured CLI, provider, host isolation or full product delivery evidence for this configuration.',evidence:[],...extra});
  for (const ownership of ['personal','organization']) add('public-'+ownership,{ownership});
  for (const hostArch of ['x64','arm64']) for (const capability of ['cli-lifecycle','host-isolation']) {
    add(`macos-${hostArch}-${capability}`,{hostOS:'macos',hostArch,capability});
  }
  for (const agent of ['codex','claude','gemini']) add(agent,{agent,capability:'agent-execution',
    limitations:'Adapter implemented; source/contract tests are not actual provider execution or platform support.'});
  add('private',{visibility:'private',status:'Unsupported',limitations:'Private repositories are outside the approved product scope.'});
  add('unsafe-host',{isolation:'none',status:'Unsupported',limitations:'A credential-bearing host without required workspace/credential isolation is unsafe.'});
  // This is a source-test capability only; it grants no execution eligibility.
  add('release-source-contract',{capability:'source-contract',status:'Supported',
    limitations:'Retained local release contract tests only. No CLI/platform/provider/P1 certification.'});
  const e=entries.at(-1);
  e.evidence=[{type:'source-contract',reference:'test/release.test.mjs',sha256:releaseHash(read('test/release.test.mjs')),
    capability:e.capability,configuration:releaseHash(JSON.stringify(configuration(e)))}];
  return {format:1,components,entries};
}
export function prepareRelease({root=process.cwd(),base,mergedCommit=null,pack=true}) {
  const source=sourceBinding({root,base,mergedCommit});
  const read=path=>readFileSync(join(root,path));
  const pkg=JSON.parse(read('package.json')); releaseVersion(pkg.version);
  mkdirSync(join(root,'out'),{recursive:true});
  if(pack) {
    const packed=JSON.parse(execFileSync('npm',['pack','--json','--offline','--ignore-scripts','--pack-destination',join(root,'out')],{cwd:root,encoding:'utf8'}));
    const bytes=read('out/'+packed[0].filename);
    verifyArchive(bytes,root); writeFileSync(join(root,'out/nibfin-core.tgz'),bytes);
    // Remove only npm's intermediate copy; never omit the mandatory archive.
    if(packed[0].filename!=='nibfin-core.tgz') unlinkSync(join(root,'out',packed[0].filename));
  }
  const archive=read('out/nibfin-core.tgz'); verifyArchive(archive,root);
  const components=releaseComponents(read),compatibility=initialCompatibility(components,read);
  const compatibilityBytes=Buffer.from(JSON.stringify(compatibility,null,2)+'\n');
  const manifest={format:1,package:pkg.name,version:pkg.version,source,components,
    archive:{name:'nibfin-core.tgz',sha256:releaseHash(archive)},compatibility:{name:'compatibility.json',sha256:releaseHash(compatibilityBytes)}};
  verifyRelease({manifest,compatibility,compatibilityBytes,archive,expectedVersion:pkg.version,expectedSource:source,read});
  writeFileSync(join(root,'out/compatibility.json'),compatibilityBytes);
  writeFileSync(join(root,'out/release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
export function verifyPreparedRelease(root=process.cwd(),{consume=false}={}) {
  const read=path=>readFileSync(join(root,path));
  for (const path of ['out/nibfin-core.tgz','out/compatibility.json','out/release-manifest.json']) {
    if (!lstatSync(join(root,path)).isFile() || lstatSync(join(root,path)).isSymbolicLink()) throw Error('release:unsafe-asset');
  }
  const manifest=JSON.parse(read('out/release-manifest.json')),compatibilityBytes=read('out/compatibility.json');
  const source=sourceBinding({root,base:manifest.source.base,mergedCommit:manifest.source.commit});
  verifyArchive(read('out/nibfin-core.tgz'),root);
  verifyRelease({manifest,compatibility:JSON.parse(compatibilityBytes),compatibilityBytes,archive:read('out/nibfin-core.tgz'),
    expectedVersion:JSON.parse(read('package.json')).version,expectedSource:source,read});
  if(consume) console.log(consumeArchive(join(root,'out/nibfin-core.tgz'),{release:true}));
  return manifest;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--verify' && process.argv.length===3) console.log(JSON.stringify(verifyPreparedRelease(process.cwd(),{consume:true}).archive));
  else if(process.argv.length===2) {
    const context=process.env.NIBFIN_RELEASE_BASE ? null:JSON.parse(readFileSync('/io/context.json'));
    const result=prepareRelease({base:process.env.NIBFIN_RELEASE_BASE ?? context.repositoryObservation.base,
      mergedCommit:process.env.NIBFIN_RELEASE_COMMIT ?? null});
    console.log(JSON.stringify({version:result.version,sourceKind:result.source.kind,base:result.source.base,
      commit:result.source.commit,sourceContent:result.source.contentSha256,archive:result.archive}));
  } else throw Error('Usage: release.mjs [--verify]');
}
