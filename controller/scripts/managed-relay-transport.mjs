import{spawn}from'node:child_process';import{mkdir,readFile,writeFile}from'node:fs/promises';
import{Runtime}from'../src/runtime.mjs';import{readBindings}from'../src/runner-binding.mjs';import{dependencyWebhookSecret}from'../src/dependency-event.mjs';import{loadRescueWakeupGrant}from'../src/rescue-wakeup.mjs';import{notificationPolicy}from'../src/independent-transport.mjs';import{loadRescueCompletionSecret}from'../src/rescue-completion.mjs';
const[mode,configPath]=process.argv.slice(2);if(!['event','dependency'].includes(mode)||!configPath)throw Error('Fixed relay mode and trusted runtime configuration are required');
const root=new URL('..',import.meta.url).pathname,runtime=await Runtime.connect(configPath,root),grant=await loadRescueWakeupGrant(runtime);if(!runtime.transport?.verified)throw Error('Independent transport enrollment required');
const directory=runtime.config.stateDirectory+'/independent-relay-transport',port=mode==='event'?8787:8788,path=mode==='event'?'/event':'/dependency-event';await mkdir(directory,{recursive:true,mode:0o700});
const child=spawn('/usr/local/bin/cloudflared',['tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:'+port],{stdio:['ignore','ignore','pipe']});let stopping=false,syncing=false,buffer='';
for(const signal of['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;child.kill('SIGTERM');});
child.once('exit',(code,signal)=>{console.log(JSON.stringify({kind:'nibfin-tunnel-exit',mode,code,signal}));process.exit(stopping?0:1);});child.once('error',()=>process.exit(1));
async function completionHook(origin){
 const repo=runtime.transport.execution.repository,secret=await loadRescueCompletionSecret('/etc/nibfin/development/rescue-completion.secret',runtime),endpoint=origin+'/rescue-completion',hooks=(await runtime.github.api('/repos/'+repo+'/hooks')).filter(h=>h.events.includes('workflow_run')&&new URL(h.config.url).pathname==='/rescue-completion');
 if(hooks.length>1)throw Error('Ambiguous completion hook; reconcile before retry');
 let hook=hooks[0];
 if(!hook){
  // A lost creation response is not permission to create a second hook.
  await writeFile(directory+'/completion-hook-create-intent.json',JSON.stringify({repository:repo,endpoint,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  hook=await runtime.github.api('/repos/'+repo+'/hooks','POST',{name:'web',active:true,events:['workflow_run'],config:{url:endpoint,content_type:'json',insecure_ssl:'0',secret:secret.toString()}});
 }else await runtime.github.api('/repos/'+repo+'/hooks/'+hook.id,'PATCH',{active:true,events:['workflow_run'],config:{url:endpoint,content_type:'json',insecure_ssl:'0',secret:secret.toString()}});
 const back=await runtime.github.api('/repos/'+repo+'/hooks/'+hook.id);if(!back.active||back.config.url!==endpoint||!back.config.secret||back.config.content_type!=='json')throw Error('Completion webhook readback mismatch');
 await runtime.github.api('/repos/'+repo+'/hooks/'+hook.id+'/pings','POST');return{repository:repo,id:hook.id,endpoint,pingRequested:true};
}
async function synchronize(origin){
 const endpoint=origin+path;let reachable=false;
 for(let n=0;n<18;n++){if(stopping)return;try{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(5000)});if(r.status===400&&await r.text()==='{"status":"REJECTED"}'){reachable=true;break;}}catch{}await new Promise(r=>setTimeout(r,3000));}
 if(!reachable)throw Error('Authenticated relay origin was not reached; endpoint not published');
 const entries=await readBindings(runtime.config,notificationPolicy(runtime,grant)),receipts=[];
 for(const[repo,entry]of Object.entries(entries)){
  if(mode==='event'){
   const resource='/repos/'+repo+'/actions/variables/NIBFIN_EVENT_ENDPOINT',before=await runtime.github.api(resource);
   if(before.value!==endpoint)await runtime.github.api(resource,'PATCH',{name:'NIBFIN_EVENT_ENDPOINT',value:endpoint});
   if((await runtime.github.api(resource)).value!==endpoint)throw Error('Variable readback mismatch');receipts.push({repository:repo,endpoint,readback:true});
  }else{
   const hooks=(await runtime.github.api('/repos/'+repo+'/hooks')).filter(h=>h.events.includes('issue_dependencies'));
   if(hooks.length!==1)throw Error('Expected one native dependency hook');const hook=hooks[0];
   await runtime.github.api('/repos/'+repo+'/hooks/'+hook.id,'PATCH',{active:true,events:hook.events,config:{url:endpoint,content_type:'json',insecure_ssl:'0',secret:dependencyWebhookSecret(entry)}});
   const back=await runtime.github.api('/repos/'+repo+'/hooks/'+hook.id);if(!back.active||back.config.url!==endpoint||!back.config.secret||back.config.content_type!=='json')throw Error('Dependency hook readback mismatch');
   await runtime.github.api('/repos/'+repo+'/hooks/'+hook.id+'/pings','POST');receipts.push({repository:repo,id:hook.id,endpoint,pingRequested:true});
  }
 }
 const completion=mode==='event'?await completionHook(origin):null,result={at:new Date().toISOString(),mode,endpoint,unsignedRejected:true,receipts,completion};
 await writeFile(directory+'/'+mode+'-current.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({kind:'nibfin-relay-transport-ready',...result}));
}
child.stderr.on('data',bytes=>{buffer=(buffer+bytes.toString()).slice(-8192);const origin=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];if(origin&&!syncing){syncing=true;synchronize(origin).catch(()=>{console.error(JSON.stringify({kind:'nibfin-relay-transport-failed',mode,reason:'Endpoint synchronization did not verify; inspect protected state before retry'}));child.kill('SIGTERM');});}});
