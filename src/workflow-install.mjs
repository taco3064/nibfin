import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {protectedHostFiles} from './host-source.mjs';
import {repositoryCoordinates} from './identity.mjs';
import {validateExecutionPool} from './execution-pool.mjs';
export const workflowFiles=Object.freeze(['.github/workflows/nibfin-delivery.yml','.github/workflows/nibfin-registration.yml',
  'workflow/templates/nibfin-rescue.yml','workflow/templates/nibfin-stage.yml','workflow/templates/nibfin-wakeup.yml','workflow/templates/nibfin-register.yml',
  'workflow/action/action.yml','src/workflow.mjs','src/workflow-entry.mjs','src/workflow-install.mjs','docs/workflows.md','src/host-source.mjs','docs/protected-host.md',...protectedHostFiles]);
/** Pure installation plan; consumers must compare existing bytes before authorized writes. */
export function workflowInstallation({commit,hostRepository,hostCommit,executionPool}) {
  if (![commit,hostCommit].every(s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s))) throw Error('workflow:immutable-pin');
  if (typeof hostRepository!=='string') throw Error('workflow:host-repository');
  const parts=hostRepository.split('/');
  if (parts.length!==2 || repositoryCoordinates(...parts).key!==hostRepository) throw Error('workflow:host-repository');
  const read=path=>readFileSync(new URL('../'+path,import.meta.url));
  const manifest=JSON.parse(read('package.json'));
  const inventory=['package.json','README.md',...manifest.files].map(path=>({path,sha256:createHash('sha256').update(read(path)).digest('hex')}));
  const files=new Map(workflowFiles.filter(p=>p.endsWith('.yml')&&!p.includes('/action/')).map(path=>[
    '.github/workflows/'+path.split('/').at(-1),read(path).toString().replaceAll('${{ vars.NIBFIN_BUNDLE_COMMIT }}',commit)
      .replaceAll('${{ vars.NIBFIN_HOST_COMMIT }}',hostCommit).replaceAll('${{ vars.NIBFIN_HOST_REPOSITORY }}',hostRepository)]));
  let deployments;
  if(executionPool!==undefined){
    const pool=validateExecutionPool(executionPool);
    const stage=files.get('.github/workflows/nibfin-stage.yml'),delivery=files.get('.github/workflows/nibfin-delivery.yml');
    files.delete('.github/workflows/nibfin-stage.yml');files.delete('.github/workflows/nibfin-delivery.yml');
    deployments=pool.targets.map(target=>{
      const key='TARGET_'+target.repositoryId,stagePath=`.github/workflows/nibfin-stage-${target.repositoryId}.yml`,
        deliveryPath=`.github/workflows/nibfin-delivery-${target.repositoryId}.yml`;
      // Both the logical target and deployment namespace are literal installed
      // bytes. Dispatch inputs cannot pick a different repo or executable source.
      const render=text=>text.replaceAll('${{ github.repository_id }}',target.repositoryId)
        .replaceAll('          mode:',`          deployment_key: ${key}\n          mode:`);
      files.set(stagePath,render(stage).replace('./.github/workflows/nibfin-delivery.yml','./'+deliveryPath)
        .replace('          mode: lookup','          host_token: ${{ secrets.NIBFIN_HOST_TOKEN }}\n          mode: lookup'));
      files.set(deliveryPath,render(delivery));
      return {...target,source:pool.source,stagePath,deliveryPath,key,variables:{
        options:`NIBFIN_${key}_HOST_OPTIONS`,capabilitySource:`NIBFIN_${key}_HOST_CAPABILITY_SOURCE`,
        sourceApprovals:`NIBFIN_${key}_SOURCE_APPROVALS`}};
    });
  }
  return {version:1,coreVersion:manifest.version,commit,inventory,files,
    ...(deployments?{deployments}:{}),
    variables:{NIBFIN_BUNDLE_COMMIT:commit,NIBFIN_HOST_REPOSITORY:hostRepository,NIBFIN_HOST_COMMIT:hostCommit}};
}
