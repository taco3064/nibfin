// Local deadline reconstruction from PR54/PR57. No interval, cron or idle Action.
import {eligibleRescueRecheck} from './rescue.mjs';
import {rescueNeed as need} from './rescue-policy.mjs';
export async function startRescueWakeups({records,controller,receiver,now=Date.now,
  setTimer=setTimeout,clearTimer=clearTimeout,onError}={}) {
  need(typeof onError==='function'&&typeof records?.subscribe==='function','notifier');
  let closed=false,running=false,again=false,timer=null;
  async function refresh() {
    if(closed)return;if(running){again=true;return;}running=true;
    if(timer!==null)clearTimer(timer);timer=null;
    try {
      await receiver.process();
      const state=await records.read();
      for(const c of Object.values(state.cases).filter(c=>eligibleRescueRecheck(c)&&c.nextCheckAt<=now()).slice(0,10))
        await controller.wake(c.id);
    } catch {await onError({kind:'nibfin-rescue-notifier',reason:'refresh-failed'});}
    finally {
      try {
        const state=await records.read(),deadlines=[...Object.values(state.cases).filter(eligibleRescueRecheck),
          ...Object.values(state.inbox).filter(v=>v.status==='pending')].map(c=>c.nextCheckAt);
        need(deadlines.every(Number.isSafeInteger),'deadline');
        if(!closed&&deadlines.length)timer=setTimer(()=>void refresh(),Math.min(2147483647,Math.max(15000,Math.min(...deadlines)-now())));
      } catch {await onError({kind:'nibfin-rescue-notifier',reason:'deadline-read-failed'});}
      running=false;
      if(again&&!closed){again=false;queueMicrotask(()=>void refresh());}
    }
  }
  const unsubscribe=await records.subscribe(()=>{if(running)again=true;else void refresh();});
  need(typeof unsubscribe==='function','subscription');
  await refresh();
  return Object.freeze({refresh,close(){closed=true;if(timer!==null)clearTimer(timer);unsubscribe();}});
}
