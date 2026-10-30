import { readFile,writeFile,mkdir,readdir,lstat,open } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { digest,canonical,binding } from './core.mjs';
import { verifyGrant,coreDigest,verifyCoreUpgrade,outside } from './authority.mjs';
import { runtimeConfigurationHash } from './runtime.mjs';
import { Store } from './store.mjs';
import { unitId,issueLeaseId,projectUnit } from './dynamic.mjs';
import { verifyOwnerHolds } from './owner-hold.mjs';
import { verifyRequirementRevision,verifyRevisionHolds,revisionStore } from './requirement-revision.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const sorted=xs=>[...xs].sort();
const same=(a,b)=>canonical(a)===canonical(b);

// Read-only provider adapter. No Issue text can choose queries or endpoints.
export async function readRevisionIssue(github,subject){
  const i={...subject,id:subject.issueId}, remote=await github.issue(i);
  const repository=await github.repository(subject.repository);
  need(remote.node_id===subject.issueId && String(repository.id)===subject.repositoryId,'REVISION_IDENTITY_CHANGED');
  const projects=[],seen=new Set();let cursor=null;
  do{
    need(!seen.has(cursor),'REVISION_PROJECT_PAGINATION_INVALID');seen.add(cursor);
    const result=await github.api('/graphql','POST',{query:'query($id:ID!,$cursor:String){node(id:$id){... on Issue{id projectItems(first:100,after:$cursor){nodes{id} pageInfo{hasNextPage endCursor}}}}}',variables:{id:subject.issueId,cursor}});
    const node=result.data?.node, page=node?.projectItems;
    need(!result.errors && node?.id===subject.issueId && Array.isArray(page?.nodes) &&
      typeof page.pageInfo?.hasNextPage==='boolean','REVISION_PROJECT_READ_UNAVAILABLE');
    need(!page.pageInfo.hasNextPage || typeof page.pageInfo.endCursor==='string' && page.pageInfo.endCursor.length>0,
      'REVISION_PROJECT_PAGINATION_INVALID');
    projects.push(...page.nodes.map(n=>n.id));
    cursor=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;
    need(cursor===null || typeof cursor==='string' && cursor.length>0,'REVISION_PROJECT_PAGINATION_INVALID');
  }while(cursor!==null);
  need(new Set(projects).size===projects.length && projects.every(x=>typeof x==='string'),'REVISION_PROJECT_READ_UNAVAILABLE');
  const metadata={title:remote.title,state:remote.state,labels:sorted(remote.labels.map(l=>l.name)),
    assignees:sorted(remote.assignees.map(a=>String(a.id))),milestone:remote.milestone?String(remote.milestone.id):null,projects:sorted(projects)};
  const a=await github.dependencies(i), b=await github.list(`/repos/${subject.repository}/issues/${subject.number}/dependencies/blocking`);
  const blockedBy=sorted(a.map(n=>n.node_id)),blocking=sorted(b.map(n=>n.node_id));
  need(new Set(blockedBy).size===blockedBy.length && new Set(blocking).size===blocking.length,'REVISION_NATIVE_READ_INVALID');
  return {complete:true,issueId:subject.issueId,repositoryId:subject.repositoryId,body:remote.body,bodyHash:digest(remote.body),
    metadata,metadataHash:digest(metadata),blockedBy,blocking,evidence:[`https://github.com/${subject.repository}/issues/${subject.number}`,`read:${new Date().toISOString()}`]};
}
async function inventory(root,path){
  const entries=[];
  async function walk(p){let stat;try{stat=await lstat(p);}catch(e){if(e.code==='ENOENT')return;throw e;}
    need(!stat.isSymbolicLink(),'REVISION_HISTORY_SYMLINK');
    if(stat.isDirectory())for(const name of (await readdir(p)).sort())await walk(join(p,name));
    else {need(stat.isFile(),'REVISION_HISTORY_SPECIAL_FILE');const bytes=await readFile(p);
      entries.push({path:relative(root,p),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}
  await walk(path);return entries;
}
async function syncDirectory(path){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
export async function createRevisionHost(config,root,github,signedRevision,{containers=githubLocalContainers}={}){
  need(process.platform==='linux','REVISION_OPERATOR_LINUX_REQUIRED');
  need(outside(root,config.stateDirectory) && outside(root,config.publicKeyPath) &&
    outside(config.stateDirectory,config.agent.authDirectory),'REVISION_TRUSTED_PATHS_INVALID');
  const publicKey=await readFile(config.publicKeyPath,'utf8');
  const initialBundle=await github.grant(config.grantSource), grant=verifyGrant(initialBundle,publicKey);
  const record=verifyRequirementRevision(signedRevision,grant,publicKey);
  const archiveRoot=join(config.stateDirectory,'requirement-archives',record.revisionHash);
  const identify=s=>grant.manifest.issues.find(i=>i.id===s.issueId);
  const oldStore=s=>new Store(config.stateDirectory,unitId(grant,identify(s)));
  const installedCoreDigest=await coreDigest(root);
  const host={installedCoreDigest,store:revisionStore(config.stateDirectory,grant),
    syncJournal:async()=>{await syncDirectory(host.store.directory);await syncDirectory(config.stateDirectory);},
    authorize:async()=>{
      const current=await github.grant(config.grantSource), approved=verifyGrant(current,publicKey);
      need(digest(current.payload)===record.parentPayloadHash && digest(current.requirementRevision)===record.revisionHash &&
        digest(signedRevision)===record.revisionHash,'REVISION_ENROLLMENT_CHANGED');
      verifyRequirementRevision(current.requirementRevision,approved,publicKey);
      verifyRevisionHolds(record,verifyOwnerHolds(current.ownerExecutionHolds,approved,publicKey));
      need(approved.policy.stateDirectory===config.stateDirectory && approved.policy.runtimeHash===runtimeConfigurationHash(config), 'REVISION_CONFIG_CHANGED');
      const actualDigest=await coreDigest(root);
      need(actualDigest===record.requiredCoreDigest,'REVISION_CORE_NOT_INSTALLED');
      if(actualDigest!==approved.policy.coreDigest){
        const upgrade=[current.coreUpgrade,...(current.coreUpgrades||[])].find(x=>x?.payload?.toCoreDigest===actualDigest);
        need(upgrade,'REVISION_CORE_UPGRADE_UNAPPROVED');verifyCoreUpgrade(upgrade,approved,actualDigest,publicKey);
      }
      const actor=await github.api('/user');need(actor.type==='User' && String(actor.id)===approved.actorGitHubUserId,'REVISION_OPERATOR_CHANGED');
      need(digest(await github.text(config.proposalSource))===approved.manifest.proposalHash,'REVISION_PARENT_PROPOSAL_CHANGED');
      const outbox=await new Store(config.stateDirectory,`actions-outbox:${approved.policy.actionExecution.repositoryId}`).read();
      need(!Object.values(outbox.items||{}).some(item=>record.subjects.some(s=>s.issueId===item.request?.issueId) && !item.finishedAt),
        'REVISION_OUTBOX_RECONCILIATION_REQUIRED');
    },
    withSubjectLeases:async(subjects,work)=>{
      const ids=subjects.flatMap(s=>[issueLeaseId(identify(s)),unitId(grant,identify(s))]);
      const enter=async n=>n===ids.length?work():new Store(config.stateDirectory,ids[n]).lease(()=>enter(n+1));return enter(0);
    },
    history:async s=>{
      const state=await oldStore(s).read(), stored=state.issues?.[s.issueId];
      const active=await containers(config.agent);need(Array.isArray(active) && active.length===0,'REVISION_ACTIVE_AGENT_PRESENT');
      return {stateHash:digest(state),pending:state.pending,candidate:!!stored?.candidate,completed:!!state.completion || !!stored?.completed,
        shapeHash:stored?.shape?.bodyHash || null,quiescent:true,state};
    },
    archive:async(s,h)=>{
      const projected=projectUnit(grant,identify(s));
      const paths=[join(config.stateDirectory,'workspaces',digest(projected.manifest.id))];
      for(const role of ['shaper','deliver']){
        const key=digest({repository:s.repository,issue:s.issueId,scope:s.oldScopeHash,binding:binding(projected.manifest,projected.policy),role});
        paths.push(join(config.stateDirectory,'role-sessions',key),new Store(config.stateDirectory,'role-session:'+key).directory);
      }
      // Capture only fixed per-execution directories named by Core execution
      // identities. Arbitrary prose/path references cannot expand an archive to
      // unrelated subjects, their working files or the entire state directory.
      const scan=value=>{if(Array.isArray(value))value.forEach(scan);else if(value&&typeof value==='object'){
        if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.executionId||''))
          for(const folder of ['executions','delivery-input-snapshots'])paths.push(join(config.stateDirectory,folder,value.executionId));
        Object.values(value).forEach(scan);
      }};scan(h.state);
      const files=new Map();for(const path of new Set(paths))for(const row of await inventory(config.stateDirectory,path))files.set(row.path,row);
      const observed=await readRevisionIssue(github,s);
      need(observed.bodyHash===s.oldBodyHash && observed.metadataHash===s.metadataHash &&
        same(observed.blockedBy,sorted(s.blockedBy)) && same(observed.blocking,sorted(s.blocking)), 'REVISION_ARCHIVE_PROVIDER_DRIFT');
      const snapshot={schemaVersion:1,issueId:s.issueId,originalBundle:initialBundle,oldScope:identify(s),state:h.state,observed,
        files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path))};
      await mkdir(archiveRoot,{recursive:true,mode:0o700});const path=join(archiveRoot,s.issueId+'.json');
      try{const f=await open(path,'wx',0o400);try{await f.writeFile(JSON.stringify(snapshot));await f.sync();}finally{await f.close();}
        await syncDirectory(archiveRoot);await syncDirectory(dirname(archiveRoot));await syncDirectory(config.stateDirectory);}
      catch(e){if(e.code!=='EEXIST')throw e;}
      const actual=JSON.parse(await readFile(path,'utf8'));
      const facts=({evidence,...observed})=>observed;
      // A restart retains the first immutable archive, including its original
      // read timestamp and unrelated parent amendments. It must still match all
      // approved old facts and the same signed parent and revision identities.
      need(actual.issueId===s.issueId && same(actual.oldScope,snapshot.oldScope) && same(actual.state,snapshot.state) &&
        same(facts(actual.observed),facts(snapshot.observed)) &&
        digest(verifyGrant(actual.originalBundle,publicKey).manifest)===record.parentManifestHash &&
        digest(actual.originalBundle.payload)===record.parentPayloadHash &&
        digest(actual.originalBundle.requirementRevision)===record.revisionHash && same(actual.files,snapshot.files), 'REVISION_ARCHIVE_CONFLICT');
      return {issueId:s.issueId,digest:digest(actual),verified:true};
    },
    verifyArchives:async archives=>{
      for(const archive of archives){const snapshot=JSON.parse(await readFile(join(archiveRoot,archive.issueId+'.json'),'utf8'));
        need(digest(snapshot)===archive.digest,'REVISION_ARCHIVE_CHANGED');
        const s=record.subjects.find(x=>x.issueId===archive.issueId);need(s && digest(await oldStore(s).read())===s.oldStateHash,'REVISION_OLD_HISTORY_CHANGED');
        for(const row of snapshot.files){const path=resolve(config.stateDirectory,row.path);need(outside(config.stateDirectory,path)===false,'REVISION_HISTORY_PATH_INVALID');
          const bytes=await readFile(path);need(bytes.length===row.size && createHash('sha256').update(bytes).digest('hex')===row.sha256,'REVISION_HISTORY_CHANGED');}
      }
    },
    observe:s=>readRevisionIssue(github,s),
    mutate:async(op,s)=>{
      // Exactly one protected Shape retirement and six raw-body replacements.
      // No Grant, native dependency, title, state or other metadata write exists.
      if(op.kind==='retire-shape' && s.oldShapeHash) await github.removeLabel(identify(s),'shaped');
      else if(op.kind==='replace-scope')await github.updateIssue(identify(s),{body:s.newScopeBody});
      else throw Error('REVISION_OPERATION_DENIED');
    }};
  return {host,record,grant};
}
async function githubLocalContainers(agent){
  const {command}=await import('./process.mjs');
  const {dockerCommand}=await import('./docker-security.mjs');
  const {stdout}=await dockerCommand(agent,command)('docker',['ps','--format','{{.Names}}']);
  return stdout.split('\n').filter(n=>/^nibfin-[a-f0-9]{8}-/i.test(n));
}
