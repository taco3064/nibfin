#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { prepareDynamic } from '../src/dynamic.mjs';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { digest, plan, validateManifest } from '../src/core.mjs';
import { Store } from '../src/store.mjs';
import { Runtime, runtimeConfigurationHash } from '../src/runtime.mjs';
import { GitHub } from '../src/github.mjs';
import { enrollment } from '../src/enrollment.mjs';
import { continueCohort } from '../src/continuation.mjs';
import { coreDigest, signGrant, verifyGrant } from '../src/authority.mjs';
import { createRoot, enrollBinding, revokeBinding } from '../src/runner-binding.mjs';
import { watchDispatch } from '../src/dispatch.mjs';
import { dispatchServiceCheck, disablePublicRunner } from '../src/runner-operations.mjs';
import { runActionLifecycle,completionTargets } from '../src/action-lifecycle.mjs';
import {loadIssueScopes} from '../src/issue-scope.mjs';
import { createActionRelayServer } from '../src/action-relay.mjs';
import { readBindings } from '../src/runner-binding.mjs';
import {queueActionRescues,runRescue,rescueOutputs} from '../src/rescue.mjs';
import {rescueLog,cleanRescueText} from '../src/rescue-policy.mjs';
import {startRescueWakeups} from '../src/rescue-wakeup.mjs';
import {loadRescueWakeupGrant} from '../src/rescue-wakeup.mjs';
import {loadRescueCompletionSecret,receiveRescueCompletion,startRescueCompletions} from '../src/rescue-completion.mjs';
import {rescueConclusion} from '../src/rescue-result.mjs';

const [command, ...args] = process.argv.slice(2);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  let output;
  switch (command) {
    case 'serve-rescue-wakeups': {
      if(args.length!==1)throw Error('serve-rescue-wakeups requires the trusted runtime config');
      const runtime=await Runtime.connect(args[0],root),service=await startRescueWakeups(runtime),completions=await startRescueCompletions(runtime);
      await new Promise(resolve=>{for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{service.close();completions.close();resolve();});});
      break;
    }
    case 'rescue-run':
    case 'rescue-verify': {
      if(args.length!==1||!process.env.GITHUB_EVENT_PATH)throw Error('Rescue requires its trusted config and pinned Actions event');
      const bytes=await readFile(process.env.GITHUB_EVENT_PATH);if(bytes.length>1024*1024)throw Error('Oversized Rescue event');
      output=await runRescue(await Runtime.connect(args[0],root),JSON.parse(bytes),{verifyOnly:command==='rescue-verify'});
      await rescueOutputs(output);
      if(rescueConclusion(output.outcome)==='failure')process.exitCode=2;
      break;
    }
    case 'serve-dependency-events':
    case 'serve-action-events': {
      if (args.length !== 2 && !(command==='serve-action-events'&&args.length===3)) throw new Error('serve-action-events requires trusted runtime config and relay enrollment policy, with an optional protected completion secret');
      const runtime = await Runtime.connect(args[0], root);
      const completionGrant=args[2]?await loadRescueWakeupGrant(runtime):null;
      const completionSecret=args[2]?await loadRescueCompletionSecret(args[2],runtime):null;
      const server = createActionRelayServer(async repository => {
        // Local operator-controlled enrollment authorizes notifications only.
        // Execution still needs a separately verified live Owner Grant.
        const policy = await json(args[1]);
        const entries = await readBindings(runtime.config, policy);
        if (!entries[repository] || !policy.actionEvents?.[repository]) return null;
        return { github: runtime.github, entry: entries[repository], policy: policy.actionEvents[repository],
          execution: policy.actionExecution, stateDirectory: runtime.config.stateDirectory,
          resolveIssueReferences:async payload=>{
            const grant=verifyGrant(await runtime.github.grant(runtime.config.grantSource),await readFile(runtime.config.publicKeyPath,'utf8'));
            await loadIssueScopes(runtime,grant);return completionTargets(runtime,grant,payload);
          } };
      }, { dependencyOnly: command === 'serve-dependency-events',...(completionSecret?{rescueCompletion:(bytes,headers)=>receiveRescueCompletion(runtime,completionGrant,completionSecret,bytes,headers)}:{}) });
      server.listen(command === 'serve-dependency-events' ? 8788 : 8787, '127.0.0.1');
      await new Promise((resolve, reject) => { server.once('close', resolve); server.once('error', reject); });
      break;
    }
    case 'action-run': {
      if (args.length !== 1 || !process.env.GITHUB_EVENT_PATH) throw new Error('action-run requires <trusted-config.json> inside its enrolled Actions job');
      const bytes = await readFile(process.env.GITHUB_EVENT_PATH);
      if (bytes.length > 1024 * 1024) throw new Error('Actions event exceeds the input limit');
      const runtime = await Runtime.connect(args[0], root);
      const started = performance.now();
      const event=JSON.parse(bytes.toString('utf8'));let failure;
      try { output = await runActionLifecycle(runtime,event); }
      catch(error){failure=error;}
      finally { console.error(JSON.stringify({ kind: 'action-read-metrics', elapsedMs: Math.round(performance.now() - started), ...runtime.github.metrics })); }
      try{await queueActionRescues(runtime,output??{},event,failure);}catch(error){console.error(JSON.stringify({kind:'nibfin-rescue-enqueue-failed',code:error.code??'UNCLASSIFIED',reason:cleanRescueText(error.message)}));}
      if(failure)throw failure;
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'handoffs=' + JSON.stringify(output.handoffs || []) + '\n');
      break;
    }
    case 'prepare-dynamic': {
      if (args.length !== 3) throw new Error('prepare-dynamic requires <trusted-config.json> <policy-template.json> <new-output-directory>');
      const config = await json(args[0]);
      const result = await prepareDynamic(await GitHub.connect(config.credentialFile), config, await json(args[1]), { id: randomUUID(), coreDigest: await coreDigest(root), runtimeHash: runtimeConfigurationHash(config) });
      await mkdir(args[2], { mode: 0o700 });
      await writeFile(resolve(args[2], 'payload.json'), JSON.stringify(result.payload, null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile(resolve(args[2], 'review.md'), result.summary, { flag: 'wx', mode: 0o600 });
      output = { status: 'DRAFT', executionAuthorized: false, directory: resolve(args[2]), issues: result.payload.manifest.issues.length };
      break;
    }
    case 'dispatch-service-check':
      if (args.length !== 1) throw new Error('dispatch-service-check requires <trusted-config.json>');
      output = await dispatchServiceCheck(await Runtime.connect(args[0], root));
      break;
    case 'runner-disable': {
      if (args.length !== 2) throw new Error('runner-disable requires <trusted-config.json> <owner-private-key.pem>');
      const config = await json(args[0]);
      output = await disablePublicRunner(config, await GitHub.connect(config.credentialFile), args[1]);
      if (output.status !== 'DISABLED') process.exitCode = 2;
      break;
    }
    case 'runner-keygen':
      if (args.length !== 1) throw new Error('runner-keygen requires <new-root-key-file>');
      output = await createRoot(args[0]);
      break;
    case 'runner-bind': {
      if (args.length !== 3) throw new Error('runner-bind requires <trusted-config.json> <owner/repo> <new-secret-output-file>');
      const config = await json(args[0]);
      output = await enrollBinding(config, await GitHub.connect(config.credentialFile), args[1], args[2], await readFile(resolve(root, 'examples/workflows/public-caller.yml'), 'utf8'));
      break;
    }
    case 'dispatch-watch':
      if (args.length !== 1) throw new Error('dispatch-watch requires <trusted-runtime-config.json>');
      output = await watchDispatch(await Runtime.connect(args[0], root));
      if (output.status === 'BLOCKED') process.exitCode = 2;
      break;
    case 'runner-revoke':
      if (args.length !== 2) throw new Error('runner-revoke requires <trusted-config.json> <owner/repository>');
      output = await revokeBinding(await json(args[0]), args[1]);
      break;
    case 'digest':
      output = { coreDigest: await coreDigest(root) };
      break;
    case 'sign': {
      if (args.length !== 3) throw new Error('sign requires <grant-payload.json> <owner-private-key.pem> <signed-output.json>');
      const payload = await json(args[0]);
      const signed = signGrant(payload, await readFile(args[1], 'utf8'));
      await writeFile(args[2], JSON.stringify(signed, null, 2), { flag: 'wx', mode: 0o600 });
      output = { signed: true, recordId: payload.recordId, file: args[2] };
      break;
    }
    case 'verify': {
      const grant = verifyGrant(await json(args[0]), await readFile(args[1], 'utf8'));
      output = { verified: true, recordId: grant.recordId, cohort: grant.manifest.id };
      break;
    }
    case 'init': {
      if (args.length < 1 || args.length > 2) throw new Error('init requires <owner/repository> [approved-core-commit]');
      output = await enrollment(await GitHub.connect(), root, args[0], { coreCommit: args[1] });
      break;
    }
    case 'doctor':
    case 'watch':
    case 'resume': {
      if (args.length !== 1) throw new Error(`${command} requires <trusted-runtime-config.json>`);
      const runtime = await Runtime.connect(args[0], root);
      const options = { onProgress: event => console.error(JSON.stringify(event)) };
      output = command === 'doctor' ? await runtime.doctor() : command === 'watch' ? await continueCohort(runtime, options) : await runtime.resume(options);
      if (output.status === 'BLOCKED') process.exitCode = 2;
      break;
    }
    case 'validate': {
      const manifest = validateManifest(await json(args[0]));
      output = { valid: true, manifestHash: digest(manifest), issues: manifest.issues.length };
      break;
    }
    case 'plan': {
      const [manifest, policy, snapshot] = await Promise.all(args.slice(0, 3).map(json));
      output = { mode: 'offline-inspection', executable: false, ...plan(manifest, policy, snapshot) };
      if (output.status === 'BLOCKED') process.exitCode = 2;
      break;
    }
    case 'status': {
      if (args.length !== 2) throw new Error('status requires <state-directory> <cohort-id>');
      output = await new Store(args[0], args[1]).read();
      break;
    }
    default:
      throw new Error('Usage: node bin/controller.mjs dispatch-service-check <config> | runner-disable <config> <owner-private.pem> | runner-keygen <new-key-file> | runner-bind <config> <owner/repo> <new-secret-file> | runner-revoke <config> <owner/repo> | dispatch-watch <config> | init <owner/repo> | doctor <trusted-config.json> | resume <trusted-config.json> | digest | sign <payload.json> <private.pem> <output.json> | verify <signed.json> <public.pem> | validate <manifest.json> | plan <manifest.json> <policy.json> <snapshot.json> | status <state-directory> <cohort-id>');
  }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  if(command==='rescue-run'||command==='rescue-verify')await rescueLog({outcome:'UNRESOLVED',code:error.code??'RESCUE_ERROR',reason:cleanRescueText(error.message),verification:'Rescue could not complete authenticated diagnosis; no resolution is claimed'});
  console.error(JSON.stringify({ status: 'BLOCKED', code: error.code || 'UNCLASSIFIED', httpStatus: error.status, reason: error.message }));
  process.exitCode = 2;
}
