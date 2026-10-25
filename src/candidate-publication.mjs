import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {canonicalJSON,bodyDigest} from './grants.mjs';
import {githubId,repositoryCoordinates} from './index.mjs';
import {compareEvidence,contentIdentity} from './evidence.mjs';
import {verifyWorkspace} from './workspace.mjs';
import {verifyHookReceipt} from './hooks.mjs';
import {parseCandidateObligations,reconcileCandidateObligations} from './obligations.mjs';
import {controlledIntent} from './operations.mjs';
import {nativeConcurrency} from './concurrency.mjs';

const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const need=(v)=>{if(!v)throw Error('candidate-publication:invalid');};
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const shared=['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash','shapeHash'];
const ref=v=>typeof v==='string'&&v.length<=128&&v.split('/').every(p=>/^[A-Za-z0-9_-][A-Za-z0-9_-]*$/.test(p));
const stopped=s=>need(!s?.aborted);
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};

/** Trusted, inert Git capability. No checkout, inherited environment or config is used.
 * localFixture is explicitly test-only; production uses canonical GitHub HTTPS.
 * Hosted auth must be supplied as an independently authorized trusted transport,
 * rather than passing tokens or programs into this local stored-login backend.
 */
export function createPublicationGit({repository,repositoryId,localFixture=null,onCommand=()=>{}}={}) {
  need(repositoryCoordinates(...repository.split('/')).key===repository);githubId(repositoryId);
  need(localFixture===null||isAbsolute(localFixture)&&!/[\x00-\x20]/.test(localFixture));
  let retired=false;
  const remote=localFixture??`https://github.com/${repository}.git`;
  return Object.freeze({repository,repositoryId,
    open(workspace,message,author,{signal}={}) {
      need(!retired);stopped(signal);verifyWorkspace(workspace,workspace.expected);need(Buffer.isBuffer(message)&&message.length<=1048576);
      need(author&&/^[A-Za-z0-9 ._-]{1,100}$/.test(author.name)&&/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(author.email)
        &&Number.isSafeInteger(author.timestamp)&&author.timestamp>=0);
      const root=mkdtempSync(join(tmpdir(),'nibfin-publication-'));
      const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',
        GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',
        GIT_ALLOW_PROTOCOL:localFixture?'file':'https'};
      let unresolvedProcess=false;
      const git=(args,input,transport=false)=>{
        need(!unresolvedProcess);stopped(signal);
        const argv=['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
          '-c','core.attributesFile=/dev/null','-c','credential.helper=',
          ...(transport&&!localFixture?['-c','credential.helper=!/usr/bin/gh auth git-credential']:[]),...args];
        const runEnv=transport&&!localFixture?{...env,GH_CONFIG_DIR:join(userInfo().homedir,'.config','gh'),
          GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',GH_NO_EXTENSION_UPDATE_NOTIFIER:'1'}:env;
        onCommand({file:'/usr/bin/git',args:[...argv],env:{...runEnv},cwd:root,transport});
        const r=spawnSync('/usr/bin/git',argv,{cwd:root,env:runEnv,input,timeout:30000,detached:true,
          maxBuffer:48*1024*1024,stdio:['pipe','pipe','pipe']});
        if(r.error||r.signal){
          unresolvedProcess=true;retired=true;
          try{if(r.pid)process.kill(-r.pid,'SIGKILL');}catch{/* No termination proof inferred. */}
          throw Error('candidate-publication:process-unresolved');
        }
        need(r.status===0);return r.stdout;
      };
      let closed=false;
      const close=()=>{if(!closed){rmSync(root,{recursive:true,force:true});closed=true;}
        if(unresolvedProcess)throw Error('candidate-publication:cleanup-unresolved');};
      try {
        git(['init','--bare','--template=','--object-format=sha1']);
        for(const o of workspace.objects)need(git(['hash-object','-w','-t',o.type,'--stdin'],o.bytes).toString().trim()===o.oid);
        const c=workspace.candidate;need(sha(c.base)&&sha(c.tree));
        // Base ancestry is intentionally not part of a workspace transfer.
        writeFileSync(join(root,'shallow'),c.base+'\n');
        git(['cat-file','-e',c.base+'^{commit}']);git(['cat-file','-e',c.tree+'^{tree}']);
        const who=`${author.name} <${author.email}> ${author.timestamp} +0000`;
        const header=Buffer.from(`tree ${c.tree}\nparent ${c.base}\nauthor ${who}\ncommitter ${who}\n\n`);
        const bytes=Buffer.concat([header,message]);
        const commit=git(['hash-object','-w','-t','commit','--stdin'],bytes).toString().trim();
        need(sha(commit)&&git(['cat-file','commit',commit]).equals(bytes));
        const read=refs=>{
          need(refs.every(ref));
          const out=git(['ls-remote','--refs','--',remote,...refs.map(r=>'refs/heads/'+r)],undefined,true).toString();
          const found={};
          for(const line of out.trim().split('\n').filter(Boolean)){
            const [id,name,...extra]=line.split(/\s+/);need(!extra.length&&sha(id)&&refs.some(r=>name==='refs/heads/'+r)&&!found[name]);found[name]=id;
          }
          return Object.fromEntries(refs.map(r=>[r,found['refs/heads/'+r]??null]));
        };
        return Object.freeze({commit,tree:c.tree,base:c.base,
          observe({head,base}) {
            need(ref(head)&&ref(base)&&head!==base);
            const refs=read([head,base]);
            let tree=null;
            if(refs[head]===commit){
              git(['fetch','--no-tags','--no-recurse-submodules','--depth=1','--',remote,commit],undefined,true);
              need(git(['rev-parse','FETCH_HEAD']).toString().trim()===refs[head]);
              tree=git(['rev-parse',commit+'^{tree}']).toString().trim();need(sha(tree));
              need(same(read([head,base]),refs));
            }
            return {head:refs[head],base:refs[base],tree};
          },
          push({head,base}) {
            need(ref(head)&&ref(base));const refs=read([head,base]);
            need(refs[base]===c.base&&refs[head]===null);
            // Empty expected value is an atomic absent-ref condition, never an overwrite.
            git(['push','--porcelain','--no-verify',`--force-with-lease=refs/heads/${head}:`,'--',remote,`${commit}:refs/heads/${head}`],undefined,true);
          },
          close});
      }catch{try{close();}catch{throw Error('candidate-publication:cleanup-unresolved');}throw Error('candidate-publication:git-unavailable');}
    }});
}

/** Every capability here is trusted Core-owned, inaccessible to Candidate code.
 * history is an authenticated custody adapter, NOT incoming JSON or a digest check.
 * operations must construct createControlledOperations with the supplied guard
 * and reconcileExistingPR:true. Core serializes writes using native concurrency.
 */
export function createCandidatePublication({current,workspace,authorization,dependencies,dependencyInput,
  history,git,operations}={}) {
  need([current,workspace,operations,history?.locate,history?.retain,git?.open,
    authorization?.eligibility,dependencies?.evaluate].every(f=>typeof f==='function'));
  let busy=false,retired=false,unresolved=null;
  async function checkpoint(pin,signal) {
    stopped(signal);need(same(await current(),pin));
    const a=await authorization.eligibility({operation:'commit-pr',context:pin.target,signal});
    need(a?.ok===true&&a.observation?.repositoryId===pin.target.repositoryId&&a.observation?.issueId===pin.target.issueId);
    const d=await dependencies.evaluate(structuredClone(dependencyInput),{signal});
    need(d?.outcome==='ready'&&d.target?.repositoryId===pin.target.repositoryId&&d.target?.issueId===pin.target.issueId);
    const w=await workspace();verifyWorkspace(w,pin.workspace);
    need(pin.visibility==='public'&&['personal','organization'].includes(pin.ownership));
    const t=pin.target,b=pin.binding;
    need(git.repository===t.repository&&git.repositoryId===t.repositoryId&&repositoryCoordinates(...t.repository.split('/')).key===t.repository);
    githubId(t.repositoryId);githubId(t.number);
    need(t.repositoryId===b.repositoryId&&t.issueId===b.issueId&&t.cycle===w.expected.binding.cycle);
    need(ref(t.headRef)&&ref(t.baseRef)&&ref(t.branchPrefix)&&t.headRef.startsWith(t.branchPrefix+'/')&&t.headRef!==t.baseRef);
    need(bodyDigest(pin.scopeBody)===b.scopeHash&&bodyDigest(pin.shapeBody)===b.shapeHash);
    need(same(w.expected.binding,{repository:t.repository,cycle:t.cycle,policy:b.policy,scopeHash:b.scopeHash,shapeHash:b.shapeHash}));
    need(Array.isArray(t.paths)&&t.paths.length&&w.metadata.permittedPaths.every(p=>t.paths.includes(p)));
    const parsed=parseCandidateObligations(pin.shapeBody);
    need(reconcileCandidateObligations(parsed,pin.obligations).ok&&same(parsed.inventory,w.metadata.inventory));
    const checked={};
    for(const name of ['author','validator','publication','deliver','accept','secondStage']) {
      const e=pin.evidence[name];checked[name]=compareEvidence(e.value,e.current);
      for(const k of shared)if(!(name==='author'&&k==='shapeHash'))need(checked[name].binding[k]===b[k]);
    }
    const {author,validator,publication,deliver,accept,secondStage}=checked;
    need(author.stage==='shape'&&validator.stage==='shape-validator'&&publication.stage==='publication'
      &&deliver.stage==='deliver'&&accept.stage==='accept'&&secondStage.stage==='pre-commit-hooks');
    need(author.inputs.body===b.shapeHash&&validator.inputs.author===author.execution.id
      &&publication.inputs.author===author.execution.id&&publication.inputs.validator===validator.execution.id
      &&publication.inputs.validation===contentIdentity(validator)&&deliver.inputs.publication===contentIdentity(publication));
    need(same(deliver.inputs.candidate,w.candidate)&&same(accept.inputs.candidate,w.candidate)&&same(secondStage.inputs.candidate,w.candidate)
      &&accept.inputs.deliver===deliver.execution.id&&secondStage.inputs.accept===contentIdentity(accept));
    need(['id','request','result'].every(k=>!['id','request','result'].some(j=>accept.execution[k]===deliver.execution[j])));
    const h=pin.hooks;
    const input={workspace:w,expected:pin.workspace,profile:h.profile,message:Buffer.from(h.message,'base64'),
      observation:pin.obligations.hookObservation,phase:'pre-commit',executionId:h.executionId,
      first:h.first,firstExecutionId:h.firstExecutionId,firstReceiptCurrent:h.firstReceiptCurrent,
      firstStage:h.firstStage,firstStageCurrent:h.firstStageCurrent,firstStageIdentity:contentIdentity(h.firstStage),
      accept,acceptCurrent:pin.evidence.accept.current};
    need(input.message.toString('base64')===h.message);
    verifyHookReceipt(h.receipt,input,h.receiptCurrent);
    need(secondStage.inputs.receipt===h.receipt.identity&&same(h.firstStage.inputs.candidate,w.candidate));
    for(const k of shared)need(h.firstStage.binding[k]===b[k]);
    need(same(await current(),pin));stopped(signal);return w;
  }
  return Object.freeze({async run({signal:caller}={}) {
    const signal=AbortSignal.any([AbortSignal.timeout(120000),...(caller?[caller]:[])]);
    if(busy||retired)return {outcome:'blocked',finding:'candidate-publication:busy',reconciliationRequired:true};
    busy=true;let session,identity,records=[],cleanup=false;
    try {
      const pin=frozen(structuredClone(await current()));
      let w=await checkpoint(pin,signal);
      identity=contentIdentity({kind:'accepted-publication-v1',pin});
      need(unresolved===null||unresolved===identity);
      const load=async()=>{
        const r=await history.locate({identity,target:structuredClone(pin.target),signal});stopped(signal);
        if(r?.outcome==='new'){need(r.identity===identity);return [];}
        need(r?.outcome==='found'&&Array.isArray(r.records)&&r.records.length>0);
        const list=r.records;
        list.forEach((v,i)=>need(v.version===1&&v.identity===identity&&v.sequence===i
          &&v.previous===(i?contentIdentity(list[i-1]):null)&&['intent','commit','push-attempt','branch-readback','published'].includes(v.event?.kind)));
        need(list[0].event.kind==='intent'&&same(list[0].event.pin,pin));return structuredClone(list);
      };
      const append=async event=>{
        need(same(await load(),records));
        const record={version:1,identity,sequence:records.length,previous:records.length?contentIdentity(records.at(-1)):null,event};
        await history.retain({identity,record:structuredClone(record),signal});
        const next=await load();need(same(next,[...records,record]));records=next;
      };
      records=await load();
      if(!records.length)await append({kind:'intent',pin});
      w=await checkpoint(pin,signal);
      session=git.open(w,Buffer.from(pin.hooks.message,'base64'),pin.author,{signal});
      const commit={commit:session.commit,tree:session.tree,base:session.base};
      need(sha(commit.commit)&&commit.tree===w.candidate.tree&&commit.base===w.candidate.base);
      const old=records.find(r=>r.event.kind==='commit');
      if(old)need(same(old.event.value,commit));else await append({kind:'commit',value:commit});
      const refs={head:pin.target.headRef,base:pin.target.baseRef};
      const observe=()=>{const o=session.observe(refs);need(o.base===commit.base);return o;};
      let remote=observe();
      if(remote.head===null) {
        need(!records.some(r=>r.event.kind==='push-attempt'));
        await append({kind:'push-attempt',value:commit});
        await checkpoint(pin,signal);
        try{session.push(refs);}catch{/* Readback, never exit status, resolves effects. */}
        remote=observe();
      }
      need(remote.head===commit.commit&&remote.tree===commit.tree);
      await append({kind:'branch-readback',value:remote});
      await checkpoint(pin,signal);
      const t=pin.target;
      const intent=controlledIntent({version:1,kind:'pr',correlation:pin.correlation,source:pin.source,
        binding:{repository:t.repository,repositoryId:t.repositoryId,issueId:t.issueId,number:t.number,cycle:t.cycle,
          scopeHash:pin.binding.scopeHash,shapeHash:pin.binding.shapeHash,authorization:pin.binding.grant,
          runId:pin.source.runId,attempt:pin.source.attempt,candidate:pin.workspace.identity,base:commit.base,head:commit.commit},
        target:{id:t.repositoryId,number:null,workflow:null},payload:{...pin.pr,head:t.headRef,base:t.baseRef}});
      const guard=async actual=>{need(same(actual,intent));await checkpoint(pin,signal);
        const o=observe();need(o.head===commit.commit&&o.tree===commit.tree);};
      const ops=await operations({intent:frozen(structuredClone(intent)),beforeSubmit:guard,reconcileExistingPR:true,concurrency:nativeConcurrency({
        repository:t.repository,repositoryId:t.repositoryId,scope:'repository-write'})});
      await guard(intent);
      const pr=await ops.execute(intent,{signal});
      need(pr.outcome==='confirmed-success'&&pr.continuation===true);
      await guard(intent);
      const value={identity,candidate:pin.workspace,accept:contentIdentity(pin.evidence.accept.value),
        hooks:contentIdentity(pin.evidence.secondStage.value),...commit,refs,branch:observe(),pr};
      await append({kind:'published',value});
      await guard(intent);
      session.close();session=null;
      unresolved=null;return {outcome:'published',value};
    }catch(error){
      if(error?.message==='candidate-publication:cleanup-unresolved'){cleanup=true;retired=true;}
      if(session)try{session.close();session=null;}catch{cleanup=true;retired=true;}
      if(records.length)unresolved=identity;
      return {outcome:'blocked',finding:cleanup?'candidate-publication:cleanup-unresolved':'candidate-publication:invalid-or-unresolved',
        reconciliationRequired:records.length>0||cleanup||unresolved!==null,...(identity?{identity:unresolved??identity}:{})};
    }finally{busy=false;}
  }});
}
