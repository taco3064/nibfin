const {readFileSync}=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');
const text=readFileSync(require('node:path').join(__dirname,'../workflows/ci-kairo-wakeup.yml'),'utf8');
const script=text.split("node <<'NODE'\n")[1].split('\n          NODE')[0].split('\n').map(line=>line.slice(10)).join('\n');
const repository='owner/project',sha='a'.repeat(40),owner={id:42};
async function run(mutate=()=>{},expectedFailure=false){
 const ci={id:10,run_attempt:1,status:'completed',event:'pull_request',path:'.github/workflows/core-ci.yml',head_sha:sha,repository:{full_name:repository},head_repository:{full_name:repository}};
 const fixture={event:{repository:{full_name:repository,default_branch:'main',owner},workflow_run:ci},liveRun:structuredClone(ci),pr:{number:5,state:'open',draft:false,head:{sha,repo:{full_name:repository}},base:{ref:'main',repo:{full_name:repository}},user:{...owner},title:'Kairo: deliver #107',body:'Implements #107.\n\nManaged by the approved Kairo cohort. Closure follows verified delivery gates.'},issue:{state:'open',user:{...owner},node_id:'I_test_107',labels:[{name:'scope'}]},associated:[{number:5}]};
 mutate(fixture);const posts=[],logs=[],process={env:{GITHUB_EVENT_PATH:'event.json',GITHUB_REPOSITORY:repository,GH_TOKEN:'test-only-token',APPROVED_WORKFLOWS:JSON.stringify(['.github/workflows/core-ci.yml'])},exitCode:0};
 const context={require:()=>({readFileSync:()=>JSON.stringify(fixture.event)}),process,console:{log:s=>logs.push(s),error:s=>logs.push(s)},fetch:async(url,options)=>{
  const path=url.replace('https://api.github.com/repos/'+repository,'');
  if(options.method==='POST'){posts.push({path,body:JSON.parse(options.body)});return{ok:true,status:204};}
  const data=path==='/actions/runs/10'?fixture.liveRun:path==='/commits/'+sha+'/pulls?per_page=100'?fixture.associated:path==='/pulls/5'?fixture.pr:path==='/issues/107'?fixture.issue:undefined;
  assert.notEqual(data,undefined,'Unexpected endpoint '+path);return{ok:true,status:200,json:async()=>data};
 }};
 await vm.runInNewContext(script,context);assert.equal(!!process.exitCode,expectedFailure,logs.join('\n'));return posts;
}
(async()=>{
 assert.deepEqual(await run(),[{path:'/actions/workflows/kairo.yml/dispatches',body:{ref:'main',inputs:{issue_id:'I_test_107'}}}]);
 assert.equal((await run(f=>{f.event.workflow_run.conclusion='failure';f.liveRun.conclusion='failure'})).length,1);
 for(const mutate of [f=>f.pr.head.sha='b'.repeat(40),f=>f.pr.head.repo.full_name='fork/project',f=>f.pr.user.id=9,f=>f.pr.state='closed',f=>f.pr.draft=true,f=>f.pr.title='Unmanaged change',f=>f.pr.body='Implements #107.\nUntrusted arbitrary prose',f=>f.issue.state='closed',f=>f.issue.labels=[],f=>f.issue.pull_request={},f=>f.associated=[]])assert.equal((await run(mutate)).length,0);
 for(const mutate of [f=>f.event.workflow_run.path='.github/workflows/evil.yml',f=>f.event.workflow_run.head_repository.full_name='fork/project',f=>f.liveRun.head_sha='b'.repeat(40),f=>f.liveRun.run_attempt=2,f=>f.event.workflow_run.event='workflow_run',f=>f.associated=Array(100).fill({number:5})])await run(mutate,true);
 console.log('CI wakeup: positive, failed-CI, 11 no-dispatch, 6 rejection passed');
})().catch(e=>{console.error(e);process.exitCode=1});
