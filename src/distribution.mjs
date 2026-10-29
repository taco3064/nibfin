import {readFileSync,lstatSync} from 'node:fs';
import {releaseComponents,releaseHash} from './release.mjs';
import {canonicalJSON} from './canonical.mjs';

import {distributionAPI,distributionOwners} from './distribution-contract.mjs';
export {distributionAPI,distributionOwners} from './distribution-contract.mjs';
const capabilityFor=path=>path?.includes('rescue')?'recovery':path?.includes('runner-job-')?'jobAdmission':path?.startsWith('workflow/')||path?.startsWith('.github/workflows/')?'workflow':path?.startsWith('skills/')?'skills':path==='src/runtime.mjs'?'runtime':'source';
const read=path=>{
  try{
  if(typeof path!=='string'||!/^[-A-Za-z0-9_./]+$/.test(path)||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('distribution:path');
  // Only the installed package's fixed inventory is read. Reject links before
  // interpreting bytes; executable paths never come from an event or model.
  const url=new URL('../'+path,import.meta.url);
  let part=new URL('../',import.meta.url);
  for(const segment of path.split('/')){part=new URL(segment,part);if(lstatSync(part).isSymbolicLink())throw Error('distribution:link');part=new URL(part.href+'/');}
  return readFileSync(url);
  }catch{throw Object.assign(Error('distribution:missing-or-unsafe'),{capability:capabilityFor(path)});}
};
export function distributionIdentity(){
  const components=releaseComponents(read);
  const files=components.core.files.filter(f=>f.path!=='src/distribution-map.json');
  const provenance=JSON.parse(read('src/distribution-map.json'));
  if(provenance.version!==1||canonicalJSON(provenance.api)!==canonicalJSON(distributionAPI)
    ||canonicalJSON(provenance.owners)!==canonicalJSON(distributionOwners)
    ||canonicalJSON(provenance.files)!==canonicalJSON(files)){
    const mismatch=files.find(f=>!provenance.files?.some(p=>p.path===f.path&&p.sha256===f.sha256));
    throw Object.assign(Error('distribution:source-map'),{capability:capabilityFor(mismatch?.path)});
  }
  return {version:1,packageVersion:components.core.version,components,
    sourceMapSha256:releaseHash(read('src/distribution-map.json')),
    pins:{runtime:components.core.sha256,workflow:components.workflow.sha256,skills:components.skills.sha256,source:components.core.sha256,
      recovery:releaseHash(JSON.stringify(files.filter(f=>f.path.includes('rescue')))),
      jobAdmission:releaseHash(JSON.stringify(files.filter(f=>f.path.includes('runner-job-'))))}};
}
