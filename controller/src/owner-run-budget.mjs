const agentOperations=new Set(['shape','validate-shape','diagnose-shape','deliver','accept','shaper-review','diagnose-deployment']);

// Use the provider's Run start as a conservative lower bound for job start.
// Keep timing outside provenance identities so historical receipts still verify.
export async function ownerRunBudget(runtime,grant,{now=Date.now}={}){
 const limits=runtime.coreUpgrade?.executionLimits;
 if(!limits)return null;
 const jobMs=limits.jobTimeoutMinutes*60000,agentMs=limits.agentTimeoutMs,reserveMs=300000;
 if(!Number.isSafeInteger(jobMs)||!Number.isSafeInteger(agentMs)||agentMs<=0||jobMs<=agentMs+reserveMs)throw Error('Signed job budget cannot fit a bounded Agent and handoff');
 const policy=runtime.actionExecutionPolicy(grant),identity=runtime.actionIdentity;
 const run=await runtime.github.api('/repos/'+policy.repository+'/actions/runs/'+identity.runId+'/attempts/'+identity.runAttempt);
 const started=Date.parse(run.run_started_at??run.created_at);
 if(String(run.id)!==String(identity.runId)||run.run_attempt!==identity.runAttempt||run.path!==policy.workflowPath||run.repository?.full_name!==policy.repository||!Number.isFinite(started)||started>now()+60000)throw Error('Provider Run start is unavailable for the execution budget');
 const deadline=started+jobMs;
 return{deadline,shouldYield:operation=>deadline-now()<=reserveMs+(agentOperations.has(operation)?agentMs:0)};
}
