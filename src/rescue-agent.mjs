import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createLinuxCodexBackend} from './codex.mjs';
import {createLinuxClaudeBackend} from './claude.mjs';
import {createLinuxGeminiBackend} from './gemini.mjs';
import {bodyDigest} from './canonical.mjs';
import {rescueNeed as need,rescueSame as same} from './rescue-policy.mjs';
import {validateRescueTarget} from './rescue-ai.mjs';
const backends={codex:createLinuxCodexBackend,claude:createLinuxClaudeBackend,gemini:createLinuxGeminiBackend};
/** Reuses the maintained image, login, egress, read-only mounts, CLI invocation,
 * process cleanup and verification lane. This diagnostic is not a Core StageResult
 * and never enters the protected Shape/Deliver/Accept role registry.
 * bind supplies a disposable readonly snapshot, never the original workspace.
 */
export function createRescueAgentAdapter({agent,memberId,bind,retainVerification,now=Date.now}) {
  need(backends[agent]&&typeof bind==='function'&&typeof retainVerification==='function','diagnostic-adapter');
  let busy=false;
  return Object.freeze({capabilities:{rescueReadOnly:true},async diagnose(request) {
    need(!busy,'diagnostic-busy');busy=true;let backend,query,config;
    try {
      const target=validateRescueTarget(request.target);need(target.adapter===agent&&target.memberId===memberId
        &&request.role==='rescue-diagnosis'&&request.access==='read-only','diagnostic-member');
      const execution=randomUUID(),spec=await bind({target,execution});
      need(spec.config.session===undefined&&spec.memberId===memberId&&spec.disposable===true&&spec.originalWorkspace!==spec.config.environment.instances.find(i=>i.id===spec.config.instanceId)?.workspace
        &&same(spec.target,target),'diagnostic-binding');
      const instructions=readFileSync(new URL('../skills/rescue/SKILL.md',import.meta.url),'utf8'),identity=bodyDigest(instructions);
      const deadlineAt=now()+Math.min(180000,request.timeoutMs);
      config={...spec.config,diagnostic:true,timeout:Math.min(180000,request.timeoutMs),deadlineAt:deadlineAt+10000,reserveMs:10000,
        task:()=>({prompt:spec.prompt,inputs:{target,caseId:spec.caseId}})};
      backend=backends[agent](config);
      const instance=config.environment.instances.find(i=>i.id===config.instanceId);
      query={environment:config.environment.id,instance:config.instanceId,agent,execution,request:execution};
      const ready=await backend.readiness();need(ready.isolation==='verified'&&ready.read==='verified'
        &&ready.login==='available'&&ready.tool==='available','diagnostic-unavailable');
      const started=await backend.start({...query,executionIdentity:{id:execution,request:execution,result:execution,role:'rescue-diagnosis',skill:'rescue',source:null},
        binding:{...spec.binding,instructions:identity},instructions:{identity,content:instructions},
        workspace:{path:instance.workspace,access:'read'},agentLogin:{owner:config.environment.id,space:config.environment.loginSpace},processEnvironment:{}});
      need(started.status==='started','diagnostic-start');
      let collected;
      while(now()<deadlineAt&&!request.signal?.aborted) {
        collected=await backend.collect(query);if(collected.status==='complete')break;
        await new Promise(done=>setTimeout(done,20));
      }
      if(collected?.status!=='complete'||request.signal?.aborted){await backend.stop(query);need(false,'diagnostic-timeout');}
      need((await backend.termination(query)).status==='terminated'&&collected.exitCode===0
        &&collected.evidence?.execution?.id===execution&&collected.evidence?.stage==='rescue-diagnosis'
        &&same(collected.evidence.inputs,{target,caseId:spec.caseId}),'diagnostic-result');
      return {execution,terminated:true,memberId,adapter:agent,result:collected.evidence.result};
    } finally {
      try {
        if(backend&&query) {
          if((await backend.termination(query)).status!=='terminated')await backend.stop(query);
          need((await backend.termination(query)).status==='terminated','diagnostic-cleanup');
          const records=await backend.verificationEvidence(query.execution);
          for(const r of records)need((await retainVerification(r.payload))?.outcome==='retained','diagnostic-verification');
          await backend.acknowledgeVerification(records.map(r=>r.identity));
          const instance=config.environment.instances.find(i=>i.id===config.instanceId);
          const clean=await backend.cleanup({...query,resources:[instance.workspace,instance.registration,instance.service]});
          need(clean.status==='completed','diagnostic-cleanup');
        }
      } finally {busy=false;}
    }
  }});
}
