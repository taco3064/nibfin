import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {protectedHostFiles} from './host-source.mjs';
import {repositoryCoordinates} from './identity.mjs';
import {validateExecutionPool} from './execution-pool.mjs';
export const workflowFiles=Object.freeze(['.github/workflows/nibfin-delivery.yml','.github/workflows/nibfin-registration.yml',
  'workflow/templates/nibfin-rescue.yml','workflow/templates/nibfin-stage.yml','workflow/templates/nibfin-wakeup.yml','workflow/templates/nibfin-register.yml',
  'workflow/action/action.yml','src/workflow.mjs','src/workflow-entry.mjs','src/workflow-install.mjs','docs/workflows.md','src/host-source.mjs','docs/protected-host.md',...protectedHostFiles]);

// Version-2 pools have no online registrations before dispatch. The maintained
// caller therefore queues its project-local member Job directly; the protected
// control host authenticates the actual Job before leasing/JIT registration.
function nativePoolWorkflows(){
 const expression=value=>'${{ '+value+' }}',input=name=>expression('inputs.'+name);
 const inputs=['nibfin_request','nibfin_correlation','nibfin_issue','nibfin_stage','nibfin_member'];
 const fields=inputs.map(name=>'      '+name+': {type: string, required: true}').join('\n');
 const caller=['name: Nibfin independent stage v2',
  "run-name: '#"+input('nibfin_issue')+' | '+input('nibfin_stage')+' | op:'+input('nibfin_correlation')+"'",
  'on:','  workflow_dispatch:','    inputs:',fields,'permissions: {}','concurrency:',
  '  group: nibfin-v2-'+expression('github.repository_id')+'-issue-'+input('nibfin_issue'),
  '  cancel-in-progress: false','  queue: max','jobs:','  stage:','    name: stage / execute',
  '    runs-on: [self-hosted, linux, x64, "nibfin-user-'+input('nibfin_member')+'", "nibfin-request-'+input('nibfin_request')+'"]',
  '    timeout-minutes: 60','    permissions: {}','    steps:',
  '      - name: Execute the authenticated Issue stage','        shell: bash','        env:',
  ...inputs.map(name=>'          '+name.toUpperCase()+': '+input(name)),
  '          NIBFIN_REPOSITORY: '+expression('github.repository'),
  '          NIBFIN_RUN_ID: '+expression('github.run_id'),
  '          NIBFIN_RUN_ATTEMPT: '+expression('github.run_attempt'),
  '        run: /usr/local/bin/node "$HOME/.local/share/nibfin/control/runtime/client/native-stage-main.mjs"',''

 ].join('\n');
 const rescueInputs=['request_id','source_run_id','source_attempt','mode','nibfin_correlation','nibfin_issue','nibfin_stage'];
 const rescue=['name: Nibfin Rescue',
  "run-name: 'Rescue | #"+input('nibfin_issue')+' | '+input('nibfin_stage')+' | '+input('mode')+' | op:'+input('nibfin_correlation')+"'",
  'on:','  workflow_dispatch:','    inputs:',...rescueInputs.map(name=>'      '+name+': {type: string, required: true}'),
  'permissions: {}','concurrency:','  group: nibfin-rescue-'+expression('github.repository_id')+'-'+input('request_id'),
  '  cancel-in-progress: false','jobs:','  rescue:',
  '    runs-on: [self-hosted, linux, x64, "nibfin-request-'+input('nibfin_correlation')+'"]',
  '    timeout-minutes: 10','    permissions:','      actions: write','    steps:',
  '      - name: Diagnose, repair and verify the original Issue stage','        id: rescue','        continue-on-error: true',
  '        shell: bash','        env:',
  '          NIBFIN_REQUEST: '+input('nibfin_correlation'),
  '          NIBFIN_REPOSITORY: '+expression('github.repository'),
  '          NIBFIN_RUN_ID: '+expression('github.run_id'),
  '          NIBFIN_RUN_ATTEMPT: '+expression('github.run_attempt'),
  '        run: /usr/local/bin/node "$HOME/.local/share/nibfin/control/runtime/client/native-stage-main.mjs"',
  '      - name: Report the verified repair outcome','        if: always() && !cancelled()','        shell: bash','        env:',
  '          GH_TOKEN: '+expression('github.token'),
  '          RESCUE_CONCLUSION: '+expression('steps.rescue.outputs.conclusion'),
  '          RESCUE_STEP_OUTCOME: '+expression('steps.rescue.outcome'),
  '        run: |',
  '          /usr/local/bin/node --input-type=module - <<\'NODE\'',
  '          const c=process.env.RESCUE_CONCLUSION;',
  '          if(process.env.RESCUE_STEP_OUTCOME!=="success"||!["success","neutral"].includes(c))throw Error("Repair remains unresolved; see the retained AI diagnosis");',
  '          if(c==="neutral"){',
  '            const repository=process.env.GITHUB_REPOSITORY,id=process.env.GITHUB_RUN_ID;',
  '            if(!/^[a-zA-Z0-9_.-]+\\/[a-zA-Z0-9_.-]+$/.test(repository)||!/^[1-9][0-9]*$/.test(id))throw Error("Invalid reporting Run");',
  '            const r=await fetch("https://api.github.com/repos/"+repository+"/actions/runs/"+id+"/cancel",{method:"POST",headers:{Authorization:"Bearer "+process.env.GH_TOKEN,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(30000)});',
  '            if(r.status!==202)throw Error("Reporting cancellation was not accepted");',
  '            await new Promise(done=>setTimeout(done,90000));throw Error("Reporting cancellation was not applied");',
  '          }',
  '          NODE',''].join('\n');
 return new Map([['.github/workflows/nibfin-stage.yml',caller],['.github/workflows/nibfin-rescue.yml',rescue]]);
}

/** Pure installation plan; consumers must compare existing bytes before authorized writes. */
export function workflowInstallation({commit,hostRepository,hostCommit,executionPool,repository}) {
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
    if(pool.version===2){
      const target=pool.targets.find(t=>t.repository===repository);
      if(!target)throw Error('workflow:pool-repository-required');
      // Runner capacity belongs to the member. Workflow/Run/Job ownership never
      // leaves this repository, regardless of which physical slot is leased.
      // Native execution needs one project-local entry. Preserve the public
      // package's reusable files and avoid installing dormant hosted dispatchers.
      files.clear();for(const [path,bytes]of nativePoolWorkflows())files.set(path,bytes);
      return {version:1,coreVersion:manifest.version,commit,inventory,files,
        repository:target.repository,executionPool:pool,
        variables:{NIBFIN_BUNDLE_COMMIT:commit,NIBFIN_HOST_REPOSITORY:hostRepository,NIBFIN_HOST_COMMIT:hostCommit}};
    }
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
