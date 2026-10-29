import {createLinuxCodexBackend} from './codex.mjs';
import {createLinuxClaudeBackend} from './claude.mjs';
import {createLinuxGeminiBackend} from './gemini.mjs';
import {createWindowsWslBackend} from './wsl.mjs';
import {createAgentEnvironments,createAgentLifecycle} from './lifecycle.mjs';
import {runnerConfiguration,preflightRunner} from './runner.mjs';
import {createRoleBudget,createVerificationLane} from './verification.mjs';
import {prepareNodeVerification} from './node-verification.mjs';
import {contentIdentity} from './evidence.mjs';
import {canonicalJSON} from './grants.mjs';
import {skillForRole} from './evidence.mjs';
import {bodyDigest} from './canonical.mjs';
import {assertRequirementsScope} from './requirements-document.mjs';
import {importWorkspace,materializeWorkspace} from './workspace.mjs';
const fail = code => {throw Error(`role-host:${code}`);};
const clone = v=>JSON.parse(canonicalJSON(v));
const roles=['shape','shape-validator','shape-diagnosis','shaper-review','deliver','accept'];
const linux={codex:createLinuxCodexBackend,claude:createLinuxClaudeBackend,gemini:createLinuxGeminiBackend};
/** Maintained prepareRole capability consumed unchanged by Core's existing owners.
 * Protected deployment supplies identities/expectations and OS observations; checkout,
 * Issue and model inputs can neither select an adapter nor change an account/profile.
 */
export function createProtectedRoleHost({configuration,bind,retain,probe,observe,process:run,observeHost,sessions,now=Date.now}={}) {
  if(!configuration||typeof bind!=='function'||typeof retain!=='function'||typeof probe!=='function'
      ||Object.keys(configuration).sort().join(' ')!=='assignments profiles runner'
      ||!Array.isArray(configuration.profiles)||!configuration.profiles.length)fail('configuration');
  if(sessions&&[sessions.prepare,sessions.retain].some(f=>typeof f!=='function'))fail('sessions');
  const runner=runnerConfiguration(configuration.runner),profiles=new Map(),registry=createAgentEnvironments(),used=new Set();
  for(const p of clone(configuration.profiles)) {
    if(Object.keys(p).sort().join(' ')!=='agent backend id os'||profiles.has(p.id)
        ||typeof p.id!=='string'||!linux[p.agent]||!['linux','wsl'].includes(p.os))fail('profile');
    const environment=registry.describe(p.os==='linux'?p.backend.environment:p.backend.linux.environment);
    if(environment.agent!==p.agent||!((p.os==='linux'?p.backend:p.backend.linux).egress))fail('environment-or-egress');
    profiles.set(p.id,p);
  }
  const assignments=clone(configuration.assignments),instances=new Set();
  if(Object.keys(assignments).sort().join(' ')!==[...roles].sort().join(' '))fail('roles');
  for(const role of roles) {
    const p=profiles.get(assignments[role]);if(!p)fail('assignment');
    const backend=p.os==='linux'?p.backend:p.backend.linux;
    const key=`${backend.environment.id}:${backend.instanceId}`;
    // Reviewers always have distinct workspace/service/registration resources; login
    // sharing remains confined to one authenticated member environment.
    if(instances.has(key))fail('independence');instances.add(key);
  }
  const prepared=new Map();
  return Object.freeze({
    async prepareRole(task) {
      if(!roles.includes(task?.role)||task.skill!==skillForRole(task.role))fail('role');
      const profile=profiles.get(assignments[task.role]);
      const ready=await preflightRunner({configuration:runner,probe,observe});
      if(ready.status!=='ready')fail('preflight-blocked');
      const binding=await bind(clone(task));
      const {input,current,startCurrent,resultContext,deadlineAt,reserveMs,prompt,inputs}=binding;
      const shapeAuthor=binding.outputFormat==='shape-author-v1';
      const capturedDeliver=binding.captureCandidate===true;
      if(binding.captureCandidate!==undefined&&(!capturedDeliver||task.role!=='deliver'||typeof startCurrent!=='function'))fail('candidate-format');
      if(binding.outputFormat!==undefined&&(!shapeAuthor||task.role!=='shape'||typeof startCurrent!=='function'
        ||task.task?.requirementsDocument?.format!=='scope-shape-v1'))fail('output-format');
      if(input?.execution?.role!==task.role||input.execution.skill!==task.skill
          ||canonicalJSON(input.instructions)!==canonicalJSON({identity:task.instructions.identity,content:task.instructions.content})
          ||typeof current!=='function'||typeof prompt!=='string'||!inputs||['id','request','result'].some(k=>used.has(input.execution[k])))fail('binding');
      const budget=createRoleBudget({deadlineAt,reserveMs,now});
      const launchInputs=clone(inputs);
      // Native independent reviewers consume Core's complete verified transfer.
      // The configured role selects the destination; neither the transfer nor
      // model output can choose a path or replace an existing working copy.
      let workspaceReceipt=null;
      if(task.task?.workspace!==undefined||task.task?.expected!==undefined){
        if(profile.os!=='linux'||!['accept','shaper-review'].includes(task.role))fail('workspace-transfer-role');
        const descriptor=profile.backend,instance=descriptor.environment.instances.find(i=>i.id===descriptor.instanceId);
        const expected=task.task.expected;
        if(!expected||(input.workspace!==undefined&&canonicalJSON(input.workspace)!==canonicalJSON({path:instance.workspace,access:'read'}))
          ||canonicalJSON(expected.candidate)!==canonicalJSON(launchInputs.candidate)
          ||expected.binding?.repository!==task.task.repository
          ||['scopeHash','shapeHash','policy'].some(k=>expected.binding[k]!==input.binding[k]))fail('workspace-transfer-binding');
        const capture=importWorkspace(Buffer.from(canonicalJSON(task.task.workspace)),{expected});
        const materialized=materializeWorkspace(capture,{expected,root:instance.workspace});
        const reference=await retain({version:1,kind:'role-workspace',execution:clone(input.execution),
          binding:clone(input.binding),workspace:materialized.workspace});
        if(typeof reference!=='string'||!reference)fail('workspace-retention');
        workspaceReceipt={...materialized,reference};
      }
      let authored=null,candidate=null;
      const currentWithOutput=id=>{
        const value=clone(current(id));
        if(shapeAuthor&&authored)value.expected.inputs={body:authored.hash};
        if(capturedDeliver&&candidate)value.expected.inputs={...clone(launchInputs),candidate:clone(candidate)};
        return value;
      };
      const taskProvider=()=>({prompt,inputs:clone(launchInputs),...(shapeAuthor?{outputFormat:'shape-author-v1'}:{})});
      const session=sessions?await sessions.prepare({task:clone(task),execution:clone(input.execution),memberId:runner.account.githubUserId}):null;
      if(session&&(profile.os!=='linux'||profile.agent!=='codex'||session.memberId!==runner.account.githubUserId))fail('session-unsupported');
      const backendConfig=profile.os==='linux'?{...profile.backend,...(session?{session}:{}),deadlineAt,reserveMs:budget.deadlineAt-budget.cutoff,task:taskProvider,...(run?{process:run}:{})}:
        {...profile.backend,linux:{...profile.backend.linux,deadlineAt,reserveMs:budget.deadlineAt-budget.cutoff,task:taskProvider},observeHost,...(run?{process:run}:{})};
      const backend=(profile.os==='linux'?linux[profile.agent]:createWindowsWslBackend)(backendConfig);
      const lane=profile.os==='wsl'?Object.freeze({execution:input.execution.id,budget,
        command:(command,settings)=>backend.verificationCommand(input.execution.id,command,retain,settings)}):
        createVerificationLane({execution:input.execution.id,budget,retain,now,
          guard:value=>backend.assertVerificationInput(input.execution.id,value),
          process:command=>backend.verificationProcess(input.execution.id,command)});
      // Only Core's post-termination workspace owner supplies this handoff. First
      // check the complete returned launch context; never repair model-selected
      // inputs, authority, execution, publication or terminal result fields.
      const collectionBackend={...backend,async cleanup(query) {
        try {
          if(session) {
            const record=await backend.sessionEvidence(input.execution.id);
            if((await sessions.retain({...record,role:task.role}))?.outcome!=='retained')throw Error('session-retention');
          }
          const records=await backend.verificationEvidence(input.execution.id);
          const retained=[];
          for(const {identity,payload} of records){const reference=await retain(payload);if(typeof reference!=='string'||!reference)throw Error('retention');
            if(profile.os==='linux')backend.assertVerificationInput(input.execution.id,{reference});else await backend.validateVerificationEvidence(input.execution.id,{reference});retained.push(identity);}
          await backend.acknowledgeVerification(retained);
        }catch{return {status:'unresolved',residuals:[(profile.os==='linux'?profile.backend:profile.backend.linux).environment.instances.find(i=>i.id===(profile.os==='linux'?profile.backend:profile.backend.linux).instanceId).service]};}
        return backend.cleanup(query);
      },async collect(query) {
        const value=await backend.collect(query);
        if(shapeAuthor&&value.status==='complete'&&value.evidence){
          try{
            const {shapeBody,...evidence}=value.evidence;
            if(typeof shapeBody!=='string'||Buffer.byteLength(shapeBody)>1048576
              ||evidence.stage!=='shape'||canonicalJSON(evidence.execution)!==canonicalJSON(input.execution)
              ||canonicalJSON(evidence.binding)!==canonicalJSON(input.binding)
              ||canonicalJSON(evidence.inputs)!==canonicalJSON(launchInputs)
              ||(await backend.termination(query)).status!=='terminated')fail('shape-output');
            if(evidence.result?.outcome==='ready')assertRequirementsScope(shapeBody,task.task.original.body);
            const hash=bodyDigest(shapeBody);
            if(authored&&authored.hash!==hash)fail('shape-rebinding');
            if(!authored){
              const reference=await retain({version:1,kind:'shape-author-body',execution:clone(input.execution),
                binding:clone(input.binding),body:shapeBody,hash});
              if(typeof reference!=='string'||!reference)fail('shape-retention');
              authored={body:shapeBody,hash,reference};
            }
            return {...value,evidence:{...evidence,inputs:{body:hash}}};
          }catch{return {...value,exitCode:1,evidence:null};}
        }
        if(candidate&&value.status==='complete'&&value.evidence) {
          const evidence=value.evidence;
          if(evidence.stage!=='deliver'||canonicalJSON(evidence.inputs??null)!==canonicalJSON(launchInputs))
            return {...value,exitCode:1,evidence:null};
          return {...value,evidence:{...evidence,inputs:{...evidence.inputs,candidate:clone(candidate)}}};
        }
        return value;
      }};
      const descriptor=profile.os==='linux'?profile.backend:profile.backend.linux;
      const lifecycle=createAgentLifecycle({environment:descriptor.environment,instanceId:descriptor.instanceId,
        backend:collectionBackend,current:currentWithOutput,startCurrent,resultContext,collectFailures:true});
      for(const key of ['id','request','result'])used.add(input.execution[key]);
      const value=Object.freeze({taskIdentity:contentIdentity(task.task),input:clone(input),lifecycle,lane,budget,
        ...(workspaceReceipt?{workspace:clone(workspaceReceipt)}:{}),
        current:currentWithOutput,
        ...(shapeAuthor?{readBody:()=>{if(!authored)fail('shape-unavailable');return authored.body;}}:{}),
        ...(task.role==='deliver'?{bindCandidate:async value=> {
          const terminal=await lifecycle.termination(input.execution.id);
          if(terminal.termination?.status!=='terminated')fail('candidate-before-termination');
          await backend.assertCandidate(input.execution.id);
          const next=clone(value);
          if(candidate&&canonicalJSON(candidate)!==canonicalJSON(next))fail('candidate-rebinding');
          candidate=next;
        }}:{}),
        prepareNode:(options={},settings)=> {
          const instance=descriptor.environment.instances.find(i=>i.id===descriptor.instanceId);
          if(Object.keys(options).some(k=>!['project'].includes(k)))fail('node-configuration');
          if(profile.os==='wsl')return backend.prepareNode(input.execution.id,options,retain,settings);
          return prepareNodeVerification({source:instance.workspace,scratch:instance.service+'/verification',
            npm:'/usr/local/bin/npm',path:runner.path,...options,lane},settings);
        }});
      prepared.set(input.execution.id,value);return value;
    },
    get(execution) {if(!prepared.has(execution))fail('execution');return prepared.get(execution);},
    /** Bind existing stage owners; Candidate/hooks/Accept logic stays in its owner. */
    owners(owners) {
      return Object.fromEntries(Object.entries(owners).map(([name,value])=>[name,
        ['shape','deliver','accept','review','repair'].includes(name)?{...value,prepareRole:task=>this.prepareRole(task)}:value]));
    }
  });
}
