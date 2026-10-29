import {contentIdentity} from './evidence.mjs';
import {rescueNeed as need,rescueSame as same,rescueHash} from './rescue-policy.mjs';
/** Recovery metadata lives in the existing host state/custody owner. It is not a
 * delivery ledger. load must return the integrity-checked current state; commit
 * must durably CAS and read back that exact state under native writer exclusion.
 * An absent record is new only when that owner positively attests its creation.
 */
export function createRescueRecords({load,commit,exclusive,subscribe}) {
  need([load,commit,exclusive,subscribe].every(f=>typeof f==='function'),'records');
  async function read() {
    const r=await load();
    need(r?.version===1&&Number.isSafeInteger(r.revision)&&r.revision>=0
      &&r.cases&&r.inbox&&r.budgets&&r.notifications&&rescueHash(r.identity),'records');
    const {identity,...value}=r;need(contentIdentity(value)===identity,'record-integrity');
    return structuredClone(r);
  }
  async function update(change) {
    return exclusive(async()=>{
      const before=await read(),next=await change(structuredClone(before));
      if(next===null)return before;
      delete next.identity;next.revision=before.revision+1;
      const value={...next,identity:contentIdentity(next)};
      const result=await commit({expected:before.identity,value:structuredClone(value)});
      need(result?.outcome==='retained','retention');
      const after=await read();need(same(after,value),'retention-readback');return after;
    });
  }
  return Object.freeze({read,update,subscribe});
}
export function initialRescueRecords() {
  const v={version:1,revision:0,cases:{},inbox:{},budgets:{},notifications:{}};
  return {...v,identity:contentIdentity(v)};
}
