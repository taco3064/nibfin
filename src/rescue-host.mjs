import {createRescueRemedies} from './rescue-remedies.mjs';
import {createRescueController} from './rescue.mjs';
import {createRescueCompletionReceiver} from './rescue-completion.mjs';
import {createRescueProvenance} from './rescue-policy.mjs';
import {startRescueWakeups} from './rescue-wakeup.mjs';
/** Compose on the existing relay. The host only authenticates/persists/wakes;
 * repair methods are exposed solely to the authenticated workflow mode. */
export function createRescueHost({configuration,secret,attribute,onError}) {
  const provenance=createRescueProvenance({policy:configuration.policy,provider:configuration.provider});
  const controller=createRescueController({...configuration,provenance,deterministic:configuration.deterministic??createRescueRemedies(configuration.remedies)});
  const receiver=createRescueCompletionReceiver({policy:configuration.policy,secret,records:configuration.records,
    provenance,controller,attribute,now:configuration.now});
  return Object.freeze({
    receive:receiver.receive,
    backfill:receiver.backfill,
    start:()=>startRescueWakeups({records:configuration.records,controller,receiver,onError,now:configuration.now}),
    /** Called by normal Core after retaining a structured stopped result. */
    async blocked(observation) {const id=await controller.register(observation);return {caseId:id,status:'retained'};},
    report:controller.report
  });
}
