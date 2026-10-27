import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {protectedHostFiles} from './host-source.mjs';
import {repositoryCoordinates} from './index.mjs';
export const workflowFiles=Object.freeze(['.github/workflows/nibfin-delivery.yml','.github/workflows/nibfin-registration.yml',
  'workflow/templates/nibfin-stage.yml','workflow/templates/nibfin-wakeup.yml','workflow/templates/nibfin-register.yml',
  'workflow/action/action.yml','src/workflow.mjs','src/workflow-entry.mjs','src/workflow-install.mjs','docs/workflows.md','src/host-source.mjs','docs/protected-host.md',...protectedHostFiles]);
/** Pure installation plan; consumers must compare existing bytes before authorized writes. */
export function workflowInstallation({commit,hostRepository,hostCommit}) {
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
  return {version:1,coreVersion:manifest.version,commit,inventory,files,
    variables:{NIBFIN_BUNDLE_COMMIT:commit,NIBFIN_HOST_REPOSITORY:hostRepository,NIBFIN_HOST_COMMIT:hostCommit}};
}
