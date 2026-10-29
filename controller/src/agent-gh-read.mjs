// Trusted host service: arguments, never participant shell/environment/credentials.
import http from 'node:http';
import {chmod, lstat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {command} from './process.mjs';
import {ghEnvironment} from './gh-cli.mjs';
export const githubReadDirectory='/run/kairo-github-read';
export const githubReadRepositories=['taco3064/nibfin','taco3064/gh-nibfin','taco3064/nibfin-action'];
const fields={
 'issue view':'number,title,body,state,stateReason,url,author,labels,assignees,milestone,comments,createdAt,updatedAt,closedAt,id',
 'issue list':'number,title,body,state,url,author,labels,assignees,milestone,createdAt,updatedAt,id',
 'pr view':'number,title,body,state,url,author,labels,assignees,comments,createdAt,updatedAt,closedAt,mergedAt,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,additions,deletions,changedFiles,files,commits,mergeable,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,id',
 'pr list':'number,title,body,state,url,author,labels,assignees,createdAt,updatedAt,isDraft,headRefName,headRefOid,baseRefName,id',
 'run list':'databaseId,displayTitle,workflowName,event,status,conclusion,headBranch,headSha,createdAt,updatedAt,startedAt,url,attempt,number',
 'run view':'databaseId,displayTitle,workflowName,event,status,conclusion,headBranch,headSha,createdAt,updatedAt,startedAt,url,attempt,number,jobs',
 'repo view':'name,nameWithOwner,description,url,isPrivate,defaultBranchRef,homepageUrl',
 'release list':'tagName,name,isDraft,isPrerelease,publishedAt,createdAt,isLatest',
 'release view':'tagName,name,body,isDraft,isPrerelease,publishedAt,createdAt,url,assets',
};
const defaults={
 'issue view':'number,title,body,state,url,labels,assignees,comments','issue list':'number,title,state,url,labels',
 'pr view':'number,title,body,state,url,isDraft,headRefOid,baseRefName,statusCheckRollup','pr list':'number,title,state,url,isDraft,headRefName',
 'run list':'databaseId,displayTitle,workflowName,status,conclusion,headSha,url','run view':'databaseId,displayTitle,status,conclusion,headSha,jobs,url',
 'repo view':'nameWithOwner,description,url,isPrivate,defaultBranchRef','release list':'tagName,name,isDraft,isPrerelease,publishedAt','release view':'tagName,name,body,url,assets',
};
const option=new Map([['--json',null],['--jq',null],['-q','--jq'],['--limit',/^\d{1,3}$/],['-L','--limit'],['--state',/^(open|closed|merged|all)$/],['--branch',/^[\w./-]{1,200}$/],['--workflow',/^[\w.-]{1,200}$/],['--event',/^[\w_]{1,80}$/],['--status',/^[a-z_]{1,40}$/],['--attempt',/^[1-9]\d{0,8}$/],['--job',/^[1-9]\d{0,19}$/]]);
const flags=new Set(['--comments','--required','--log','--log-failed','--patch','--name-only']);
const apiPath=/^\/repos\/(taco3064\/(?:nibfin|gh-nibfin|nibfin-action))(?:\/(?:issues|pulls|commits|contents|git\/trees|git\/blobs|actions\/(?:runs|jobs|artifacts|workflows)|releases|tags|branches|compare|check-runs)(?:\/[A-Za-z0-9_.~@/-]+)?)?$/;
const deny=()=>{throw Error('gh-read: command, option or repository is outside the read-only capability');};
const safeJq=value=>value==='.'||/^\.(?:[A-Za-z_]\w*(?:\[\d*\])?|\[\d*\])(?:\.[A-Za-z_]\w*(?:\[\d*\])?)*$/.test(value);
export function githubReadRequest(input){
 if(!input||!Array.isArray(input.args)||input.args.length>40||!input.args.every(a=>typeof a==='string'&&a.length<=2048&&!/[\x00-\x1f\x7f]/.test(a)))deny();
 let repo=input.repository,args=[...input.args];
 for(let i=0;i<args.length;i++)if(args[i]==='-R'||args[i]==='--repo'){if(i+1>=args.length)deny();repo=args[i+1];args.splice(i,2);i--;}else if(args[i].startsWith('--repo=')){repo=args[i].slice(7);args.splice(i,1);i--;}
 if(args.length===1&&['--version','version'].includes(args[0]))return{args:['--version'],repository:null};
 if(args[0]==='api'){
  args.shift();let target,output=[];
  for(let i=0;i<args.length;i++){const a=args[i];if(['-X','--method'].includes(a)){if(args[++i]!=='GET')deny();}else if(a==='--hostname'){if(args[++i]!=='github.com')deny();}else if(['--jq','-q'].includes(a)){if(!args[++i]||!safeJq(args[i]))deny();output.push('--jq',args[i]);}else if(a==='--paginate'||a==='--include'||a==='-i')output.push(a);else if(a.startsWith('-')||target)deny();else target=a;}
  if(!target)deny();if(!target.startsWith('/'))target='/'+target;if(/[%\\#]|\.\./.test(target))deny();
  const u=new URL(target,'https://api.github.com'),match=apiPath.exec(u.pathname);
  if(u.origin!=='https://api.github.com'||!match||![...u.searchParams.keys()].every(k=>['page','per_page','state','sort','direction','since','ref','recursive','filter','status','branch','event','head_sha','check_name','pull_number'].includes(k)))deny();
  return{repository:match[1],args:['api','--hostname','github.com','--method','GET',target,...output]};
 }
 if(!githubReadRepositories.includes(repo))deny();const kind=args.splice(0,2).join(' ');if(!fields[kind]&&!['pr checks','pr diff'].includes(kind))deny();
 let positional,selected,output=[],raw=false;
 for(let i=0;i<args.length;i++){
  let a=args[i],inline;if(a.startsWith('--')&&a.includes('=')){[a,...inline]=a.split('=');inline=inline.join('=');}
  if(flags.has(a)){if(inline!==undefined)deny();output.push(a);if(['--log','--log-failed'].includes(a))raw=true;continue;}
  if(option.has(a)){let rule=option.get(a);if(typeof rule==='string'){a=rule;rule=option.get(a);}const value=inline??args[++i];if(!value||rule&&!rule.test(value))deny();if(a==='--limit'&&Number(value)>100)deny();if(a==='--jq'&&!safeJq(value))deny();if(a==='--json'){selected=value.split(',');if(!fields[kind]||!selected.every(f=>fields[kind].split(',').includes(f)))deny();}output.push(a,value);continue;}
  if(a.startsWith('-')||positional)deny();positional=a;
 }
 if(['issue view','pr view','pr checks','pr diff','run view'].includes(kind)&&!/^[1-9]\d{0,19}$/.test(positional??''))deny();
 if(kind.endsWith(' list')&&positional)deny();if(kind==='repo view'&&positional&&positional!==repo)deny();if(kind==='release view'&&positional&&!/^[A-Za-z0-9_.-]{1,100}$/.test(positional))deny();
 if(fields[kind]&&!selected&&!raw)output.push('--json',defaults[kind]);
 return{repository:repo,args:[...kind.split(' '),...(kind==='repo view'?[repo]:positional?[positional]:[]),...(kind==='repo view'?[]:['--repo',repo]),...output]};
}
export function createGithubReadService(run=command){
 let active=0;const server=http.createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(req.method!=='POST'||req.url!=='/read'){send(403,{error:'gh-read: read RPC only'});return;}if(active>=2){send(429,{error:'gh-read: two reads already active; retry later'});return;}active++;
  try{
   let size=0,parts=[];for await(const part of req){size+=part.length;if(size>16384)throw Error('gh-read: request too large');parts.push(part);}
   const request=githubReadRequest(JSON.parse(Buffer.concat(parts))),host=ghEnvironment();
   const env={PATH:host.PATH,HOME:host.HOME,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GH_PAGER:'cat',GH_NO_UPDATE_NOTIFIER:'1',XDG_CACHE_HOME:'/tmp/kairo-gh-read-cache'};
   const settings={env,cwd:'/',timeout:30000,limit:16*1024*1024};
   if(request.repository){const observed=JSON.parse((await run('gh',['api','repos/'+request.repository,'--jq','{full_name,private}'],settings)).stdout);if(observed.private!==false||observed.full_name!==request.repository)throw Error('gh-read: repository must remain the exact approved public repository');}
   const result=await run('gh',request.args,settings);send(200,{stdout:result.stdout,stderr:'',exitCode:0});
  }catch(error){send(403,{error:error.message.startsWith('gh-read:')?error.message:'gh-read: native read failed; check target, permissions or API availability'});}finally{active--;}
 });server.requestTimeout=35000;server.headersTimeout=10000;return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const directory=await lstat(githubReadDirectory);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid()||(directory.mode&0o022))throw Error('gh-read: unsafe socket directory');const server=createGithubReadService();server.listen(githubReadDirectory+'/read.sock',()=>{void chmod(githubReadDirectory+'/read.sock',0o600);});process.once('SIGTERM',()=>server.close(()=>process.exit(0)));}
