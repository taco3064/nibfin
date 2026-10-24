// Synthetic cryptographic and official-response fixtures, never live event proof.
// Provider references: https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues
// https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
import {actionsFixture} from './actions-fixture.mjs';
import {operationInput, operationsFixture} from './operations-fixture.mjs';
import {createEventRelay, contentIdentity, nativeExecutionPlan, canonicalJSON} from '../src/index.mjs';

export async function relayFixture(number='101') {
  const af = await actionsFixture(), verifier = af.verifier();
  const input = operationInput('dispatch');
  input.binding.number=number;input.binding.issueId='I_'+number;
  input.source.request = 'request-1'; input.payload.inputs.nibfin_request = 'request-1';
  const f = operationsFixture(input), h = 'b'.repeat(64);
  const receipt = {version:1,stage:'shape-validator',binding:{authority:h,grant:h,policy:h,core:h,runtime:h,
    instructions:h,repositoryId:'42',issueId:input.binding.issueId,scopeHash:input.binding.scopeHash,shapeHash:input.binding.shapeHash},
    execution:{role:'shape-validator',skill:'shape',id:'validator',request:'previous',result:'approved',
      source:{repositoryId:'42',workflow:h,runId:'44',attempt:'1'}},inputs:{body:input.binding.shapeHash,author:'author'},
    result:{version:1,outcome:'approved',failureClass:'none',summary:'synthetic validated',conflicts:[]}};
  const request = {id:'request-1',hint:'deliver',intent:input,
    sourcePolicy:{repositoryId:'42',workflowRef:af.expected.workflow_ref,workflowSha:af.expected.workflow_sha,
      workflowDigest:af.expected.workflowDigest,ref:af.expected.ref,actorIds:['43'],suppressionEvent:'workflow_dispatch'},
    predecessor:{identity:contentIdentity(receipt),request:'previous',result:'approved'},
    fallback:{approved:true,reason:'Explicit local provider-contract alternate wakeup'},mutation:'required'};
  const previousExpected = {...af.expected,repository_id:'42'};
  const previousSource = await verifier.authenticate(await af.sign({repository_id:'42'}),previousExpected);
  const args = {source:previousSource,receipt,current:{expected:structuredClone(receipt),consumed:[]},
    now:1000,maxAge:300,recordedAt:995,consumerExecution:'next'};
  const gate = {authorization:true,dependencies:true,upstream:true,applicability:true,runner:true,mutationReadback:true};
  const state = {lookup:true, gateCalls:0, authChanges:{}, expectedChanges:{}, sourceClaim:null, observedRun:'100'};
  const native = {name:'issues',payload:{action:'labeled',repositoryId:'42',issueId:input.binding.issueId,number,label:'shaped',stateReason:null}};
  const dispatch = {name:'workflow_dispatch',payload:{nibfin_request:'request-1',nibfin_correlation:'request-1'}};
  const fresh = (runId='100') => {
    const operations = f.fresh({runId,attempt:'1'});
    return createEventRelay({verifier, operations,
      authenticateEvent:async event => {
        if (state.sourceClaim) return state.sourceClaim;
        // Trusted host must independently authenticate the projection as well as
        // JWT identity. Here the verifier's expected projection is fixture-owned.
        const expectedPayload = event.name === 'workflow_dispatch' ? dispatch.payload : native.payload;
        if (canonicalJSON(event.payload) !== canonicalJSON(expectedPayload)) throw Error('event projection');
        const e = {...af.expected,repository_id:'42',run_id:state.observedRun,
          event_name:event.name === 'issues' ? 'issues' : 'workflow_dispatch',...state.expectedChanges};
        return verifier.authenticate(await af.sign({repository_id:'42',run_id:state.observedRun,
          event_name:e.event_name,...state.authChanges}),e);
      },
      loadRequest:async selector => {
        if (!state.lookup || selector.request && selector.request !== request.id) throw Error('unknown request');
        return request;
      },
      loadPredecessor:async () => args,
      currentGate:async () => {state.gateCalls++; return gate;}
    });
  };
  return {...f,request,receipt,args,gate,relayState:state, operationState:f.state,
    native,dispatch,fresh};
}

/** Local executable configuration fixture. Core supplies resolved identities.
 * The relay call encloses lookup, current gates, custody and reconciliation in
 * the write job. No preceding unprotected lookup decides newness.
 */
export function relayConsumerConfiguration(binding) {
  const plan = nativeExecutionPlan({...binding,maxParallel:1});
  return {name:'Local relay provider contract',
    'run-name':'nibfin-operation:${{ inputs.nibfin_correlation }}',
    on:{issues:{types:['opened','labeled','closed','reopened','edited','unlabeled','assigned','unassigned','milestoned','demilestoned']},
      workflow_dispatch:{inputs:{nibfin_request:{required:true,type:'string'},nibfin_correlation:{required:true,type:'string'}}}},
    concurrency:plan.concurrency,jobs:{relay:{'runs-on':'ubuntu-latest',concurrency:plan.jobs.write.concurrency,
      steps:[{run:'node --test test/relay.test.mjs'}]}}};
}
export async function executeRelayConsumer(relay, input) {
  // The production host supplies authenticated capabilities and holds the above
  // native groups while invoking this real public adapter. No shell interpolation.
  return relay.wake(input);
}
