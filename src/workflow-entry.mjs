// Executed only from the immutable bundle checkout. The host checkout is separately pinned.
import {readFile,appendFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {loadProtectedHost,loadProtectedDeployment} from './host-source.mjs';
import * as core from './index.mjs';
import {createWorkflowEntry,projectIssue} from './workflow.mjs';
export async function workflowMain(env=process.env,{deployment}={}) {
  let output={status:'blocked',selected:'false',reason:'host-configuration-unavailable'};
  try {
    if (!/^[a-f0-9]{40}$/.test(env.NIBFIN_BUNDLE_COMMIT??'') || !/^[a-f0-9]{40}$/.test(env.NIBFIN_HOST_COMMIT??'')) throw Error('pins');
    const context={repository:env.GITHUB_REPOSITORY?.toLowerCase(),repositoryId:env.GITHUB_REPOSITORY_ID,
      run:{id:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT},eventName:env.GITHUB_EVENT_NAME,
      event:JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'))};
    const input=env.NIBFIN_MODE==='wake'?{event:projectIssue(context.event)}:JSON.parse(env.NIBFIN_INPUT);
    if (['execute','compute'].includes(env.NIBFIN_MODE)) input.resolution=env.NIBFIN_RESOLUTION;
    const approvals=JSON.parse(env.NIBFIN_SOURCE_APPROVALS);
    const workspace=resolve(env.GITHUB_WORKSPACE);
    const host=await loadProtectedHost({
      bundle:{root:dirname(dirname(fileURLToPath(import.meta.url))),allowedRoot:join(workspace,'nibfin-bundle'),
        repository:'taco3064/nibfin',commit:env.NIBFIN_BUNDLE_COMMIT,approval:approvals.bundle},
      host:{root:env.NIBFIN_HOST_ROOT,allowedRoot:join(workspace,'nibfin-host'),repository:env.NIBFIN_HOST_REPOSITORY,
        commit:env.NIBFIN_HOST_COMMIT,approval:approvals.host}});
    if (!deployment) deployment=await loadProtectedDeployment({source:env.NIBFIN_HOST_CAPABILITY_SOURCE,
      options:env.NIBFIN_HOST_OPTIONS,approval:approvals.deployment,validate:host.validateHostOptions,mode:env.NIBFIN_MODE});
    const controller=new AbortController(),cancel=()=>controller.abort();
    process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
    try {output=await createWorkflowEntry(await host.configure({core,mode:env.NIBFIN_MODE,context,deployment})).invoke(env.NIBFIN_MODE,input,context,{signal:controller.signal});}
    finally {process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);}
  } catch { /* No raw exceptions, provider data, tokens or event text in outputs/logs. */ }
  for (const [key,value] of Object.entries(output)) {
    if (!/^[a-z_]+$/.test(key) || typeof value!=='string' || value.length>32768 || /[\r\n]/.test(value)) throw Error('workflow:output');
    await appendFile(env.GITHUB_OUTPUT,`${key}=${value}\n`);
  }
  // Rescue can exit successfully only for independently verified completion.
  // In particular a neutral Check/output must never leave this workflow green.
  if(env.NIBFIN_MODE==='rescue')return output.outcome==='RESOLVED'&&output.conclusion==='success'&&output.status==='resolved'?0:1;
  return ['blocked','unknown','unconfirmed','denied','unavailable','unresolved','rejected','expired'].includes(output.status)?1:0;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode=await workflowMain();
