import {createHash} from 'node:crypto';
import {createGithubProvider} from '../src/provider.mjs';
// Official REST API 2026-03-10 response shapes, reduced to fields consumed here.
// https://docs.github.com/en/rest/{branches/branch-protection,repos/rules,checks/runs}
// https://docs.github.com/en/rest/{commits/statuses,actions/workflow-runs,actions/workflow-jobs,repos/contents}
// Attempt jobs: https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
// Jobs have no documented run_attempt field: the requested endpoint supplies attempt provenance.
// IDs/coordinates, timestamps and source bytes are synthetic; optional unused fields omitted.
export function ciFixture(change = () => {}, {head='a'.repeat(40),baseSha='b'.repeat(40),repositoryId='9007199254740993'}={}) {
  const expected = {repository:'example-org/core', repositoryId, prId:'9007199254740995', pr:7,
    head, baseSha, baseBranch:'main', baseRepositoryId:repositoryId};
  const source = Buffer.from('name: CI\non: push\njobs: {}\n');
  const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  const pin = {context:'build', appId:'15368', sourceRepository:expected.repository, sourceRepositoryId:repositoryId,
    path:'.github/workflows/ci.yml', revision:head, blob, event:'push', runId:'31', attempt:1, job:'build'};
  const check = {id:'41',name:'build',head_sha:head,app:{id:'15368'},status:'completed',conclusion:'success'};
  const run = {id:'31',head_sha:head,repository:{id:repositoryId},head_repository:{id:repositoryId},
    path:pin.path,event:'push',run_attempt:1,status:'completed',conclusion:'success'};
  const job = {id:'51',name:'build',run_id:'31',head_sha:head,status:'completed',conclusion:'success',
    check_run_url:'https://api.github.com/repos/example-org/core/check-runs/41'};
  const rule = {type:'required_status_checks',ruleset_id:'61',ruleset_source:'example-org',ruleset_source_type:'Organization',
    parameters:{strict_required_status_checks_policy:true,required_status_checks:[{context:'build',integration_id:'15368'}]}};
  const data = {
    '':{id:repositoryId,full_name:expected.repository,private:false,visibility:'public',owner:{type:'Organization'}},
    '/pulls/7':{id:expected.prId,number:7,head:{sha:head},base:{sha:baseSha,ref:'main',repo:{id:repositoryId}}},
    '/branches/main':{name:'main',commit:{sha:baseSha},protected:true},
    '/branches/main/protection':{required_status_checks:{strict:true,contexts:['build'],checks:[{context:'build',app_id:'15368'}]}},
    '/rules/branches/main?per_page=100':[],
    [`/commits/${head}/check-runs?filter=latest&per_page=100`]:{total_count:1,check_runs:[check]},
    [`/commits/${head}/statuses?per_page=100`]:[],
    [`/actions/workflows/ci.yml/runs?head_sha=${head}&per_page=100`]:{total_count:1,workflow_runs:[structuredClone(run)]},
    '/actions/runs/31':run,
    [`/contents/${pin.path}?ref=${head}`]:{type:'file',path:pin.path,sha:blob,encoding:'base64',content:source.toString('base64')},
    '/actions/runs/31/attempts/1/jobs?per_page=100':{total_count:1,jobs:[job]}
  };
  const statuses = {}, links = {}, counts = {}, calls = [];
  const fixture = {expected,pin,check,run,job,rule,data,statuses,links,counts,calls,reply:null};
  change(fixture);
  const provider = createGithubProvider({attempts:1,transport:async request => {
    calls.push(request);
    const path = request.endpoint.slice(`/repos/${expected.repository}`.length);
    counts[path] = (counts[path] ?? 0) + 1;
    const override = fixture.reply?.(path,counts[path]);
    if (override) return override;
    if (!Object.hasOwn(data,path)) return {status:404,body:'{"message":"not found"}'};
    // Numeric database ID tokens exercise provider's lossless raw-JSON parser.
    const body = JSON.stringify(data[path]).replace(/"(id|[a-z_]+_id)":"([1-9][0-9]*)"/g,'"$1":$2');
    return {status:statuses[path] ?? 200,headers:links[path] ? {link:links[path]} : {},body};
  }});
  return {...fixture,provider};
}
