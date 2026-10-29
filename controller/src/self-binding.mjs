import {verifyCoreUpgrade} from './authority.mjs';

export const controllerRepository = 'taco3064/nibfin';
export const controllerPath = 'controller';
export const developmentRepositories = Object.freeze(['taco3064/gh-nibfin','taco3064/nibfin','taco3064/nibfin-action']);

// This binds development execution to maintained Nibfin source. It grants no
// operations and changes neither public onboarding nor existing Issue identity.
export function verifyControllerBinding(bundle,grant,installedDigest,publicKey,sourceCommit) {
 const matches=(bundle.coreUpgrades??[]).filter(a=>a.payload?.toCoreDigest===installedDigest);
 if(matches.length!==1)throw Error('Controller requires one exact signed installation');
 const approval=verifyCoreUpgrade(matches[0],grant,installedDigest,publicKey),source=approval.controllerSource;
 if(!source||source.repository!==controllerRepository||source.path!==controllerPath||source.commit!==sourceCommit||approval.sourceCommit!==sourceCommit||!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Controller source binding differs');
 const repositories=[...new Set(grant.manifest.issues.map(i=>i.repository))].sort();
 if(JSON.stringify(repositories)!==JSON.stringify(developmentRepositories)||developmentRepositories.some(r=>!Object.hasOwn(grant.policy.repositories??{},r)))throw Error('Controller development portfolio differs');
 return {repository:source.repository,path:source.path,commit:sourceCommit,installedDigest,repositories,grantRecordId:grant.recordId};
}
