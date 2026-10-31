import {verificationBudget} from './verification-runner.mjs';
import {authorizedRepositories} from './agent-gh-read.mjs';
import {recoveryPolicy,rejectSecrets} from './agent-session.mjs';
import {redactRuntimeText} from './verification.mjs';
import {createContainerEgress,endpointProfiles} from './egress.mjs';
import {containerProcess} from './process.mjs';
import {dockerArguments,assertDockerInfo,assertContainerConfiguration,imageEnvironmentOverrides,imageEnvironmentMatches} from './docker-security.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {lstatSync, realpathSync, readdirSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {resolve, join, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgentEnvironments} from './lifecycle.mjs';
import {bodyDigest, canonicalJSON} from './grants.mjs';
import {prepareCodexCredentials} from './codex-credentials.mjs';
import {skillForRole, outcomesForRole} from './evidence.mjs';

export const linuxCodexProfile = Object.freeze({id:'linux-amd64-codex-v1', docker:'28.5.1',
  codex:'codex-cli 0.163.0', node:'v22.23.3', guest:'debian-12', platform:'linux', arch:'x64'});
// Reviewed exact tuples, never an arbitrary version bypass. The original profile
// remains the default for existing callers. Native support is measured separately.
export const linuxCodexProfiles = Object.freeze({
  [linuxCodexProfile.id]: linuxCodexProfile,
  'linux-amd64-codex-docker29-v1': Object.freeze({...linuxCodexProfile,
    id:'linux-amd64-codex-docker29-v1', docker:'29.9.1'}),
  'linux-amd64-codex-node22-docker29-v1': Object.freeze({...linuxCodexProfile,
    id:'linux-amd64-codex-node22-docker29-v1',docker:'29.9.1',imageLayout:'node22-bookworm-v1'})
});
const fail = code => { throw new TypeError(`codex:${code}`); };
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const within = (a,b) => b.startsWith(a + sep);
const safePath = p => typeof p === 'string' && resolve(p) === p && p !== '/' && !/[\x00-\x20,:]/.test(p);
const entry = fileURLToPath(new URL('./codex-entry.mjs', import.meta.url));
const cleanEnv = Object.freeze({PATH:'/usr/bin:/bin',LANG:'C'});

/** External process boundary only. It cannot supply a readiness/permission override. */
export async function codexProcess(command) {const {ok,output}=await containerProcess(command);return {ok,output};}

/** Construction is inert. Configuration belongs to trusted Core, never model input. */
export function createLinuxCodexBackend(config) { return createLinuxBackend(config); }

// Shared transport seam. Profiles are trusted adapter code, never role input.
export function createLinuxBackend(config, profile = null) {
  const agent = profile?.agent ?? 'codex';
  const selectedEntry = profile?.entry ?? entry;
  const requestedProfile = config.runtimeProfile;
  if (requestedProfile !== undefined && (profile || typeof requestedProfile !== 'string'
      || !Object.hasOwn(linuxCodexProfiles,requestedProfile))) fail('runtime-profile');
  const selectedProfile = profile?.identity ?? linuxCodexProfiles[requestedProfile ?? linuxCodexProfile.id];
  const imageLayout=selectedProfile.imageLayout??'path-only-v1';
  const imageEnvironment=imageEnvironmentOverrides(imageLayout);
  const {root, image, socket, environment:original, instanceId, process:run = codexProcess,
    timeout = 300000, task, egress, recovery, githubRead, session: durableSession = null, diagnostic: diagnosticMode = false, deadlineAt = Date.now()+timeout+60000, reserveMs = 30000} = config;
  if (Object.keys(config).some(k => !['root','image','socket','environment','instanceId','process','timeout','task','egress','recovery','deadlineAt','reserveMs','githubRead','diagnostic','session','runtimeProfile'].includes(k))) fail('configuration');
  if(typeof diagnosticMode!=='boolean')fail('diagnostic');
  if (!safePath(root) || !/^sha256:[a-f0-9]{64}$/.test(image) || !safePath(socket)
      || !/^\/run\/user\/[1-9][0-9]*\/docker.sock$/.test(socket)
      || typeof task !== 'function' || typeof run !== 'function' || !Number.isInteger(timeout) || timeout < 50 || timeout > 3600000) fail('profile');
  if(!Number.isSafeInteger(deadlineAt)||!Number.isSafeInteger(reserveMs)||reserveMs<0||reserveMs>300000)fail('deadline');
  if(githubRead && (Object.keys(githubRead).sort().join(' ')!=='directory repositories'||!safePath(githubRead.directory)))fail('github-read');
  const readRepositories=githubRead?authorizedRepositories(githubRead.repositories):null;
  function brokerMounts() {
    if(!githubRead)return [];
    const directory=githubRead.directory;
    if(realpathSync(directory)!==directory||!lstatSync(directory).isDirectory()||
      readdirSync(directory).join(',')!=='read.sock'||!lstatSync(join(directory,'read.sock')).isSocket())fail('github-read');
    // Package storage is private data (0600). Publish only this fixed bridge as
    // an executable inside the disposable service owner, with exact byte/mode
    // readback. Never depend on tar/npm preserving an installed source mode.
    const client=join(instance.service,'github-read-client.mjs');
    const bytes=readFileSync(new URL('./agent-gh-client.mjs',import.meta.url));
    if(!existsSync(client))writeFileSync(client,bytes,{flag:'wx',mode:0o500});
    const stat=lstatSync(client);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o500
      ||!readFileSync(client).equals(bytes))fail('github-read-client');
    return [...mount(directory,'/github-read'),...mount(client,'/usr/local/bin/gh')];
  }
  recoveryPolicy(recovery,agent,profile?.version??selectedProfile.codex);
  const environment = createAgentEnvironments().describe(original);
  const instance = environment.instances.find(i => i.id === instanceId);
  if (environment.agent !== agent || !instance) fail('environment');
  if(durableSession&&(agent!=='codex'||Object.keys(durableSession).sort().join(' ')!=='directory id memberId'||!safePath(durableSession.directory)||!within(instance.service,durableSession.directory)||durableSession.id!==null&&!(/^[a-f0-9-]{36}$/i.test(durableSession.id))||!(/^[1-9]\d*$/.test(durableSession.memberId))))fail('session');
  const resources = [instance.workspace,instance.registration,instance.service];
  const all = [environment.loginSpace,...environment.instances.flatMap(i => [i.workspace,i.registration,i.service])];
  if (all.some(p => !safePath(p) || !within(root,p))) fail('resource-root');
  const scratch = join(instance.service,agent), verificationRoot=join(instance.service,'verification');
  let verificationPin=null;const verificationRetained=new Set();
  const states = new Map(), containers = new Map(), pins = new Map();
  let deleting = false,workPhase=false;
  let diagnostic = 'not-checked', ready = false, retired = false;
  async function command(args, ms = 15000, limit = 1048576) {
    try {
      ms=Math.min(ms,deadlineAt-(workPhase?reserveMs:0)-Date.now());if(ms<=0)return {ok:false,output:''};
      const response = await run(Object.freeze({file:'/usr/bin/docker',args:Object.freeze(dockerArguments(socket,args)),
        env:cleanEnv,timeout:ms,limit,failureOutput:true}));
      if (!response || typeof response.ok !== 'boolean' || typeof response.output !== 'string'
          || Buffer.byteLength(response.output) > limit) return {ok:false,output:''};
      return response;
    } catch { return {ok:false,output:''}; }
  }
  const network = egress ? createContainerEgress({command,image:egress.image,profile:agent,node:egress.node??false,imageLayout}) : null;
  if(egress && egress.image!==image)fail('egress-image');
  if (egress && Object.keys(egress).some(k=>!['image','node'].includes(k))) fail('egress-configuration');
  async function json(args) {
    const r = await command(args);
    if (!r.ok) throw Error();
    return JSON.parse(r.output);
  }
  function physical() {
    // Reject symlink ancestors, hard links, bind aliases, special files and mount escapes.
    const seen = new Set(); let count = 0;
    const checkPath = p => {
      if (realpathSync(p) !== p) fail('path-alias');
      for (let part=p; part !== '/'; part=dirname(part)) if (lstatSync(part).isSymbolicLink()) fail('path-alias');
    };
    checkPath(root); checkPath(selectedEntry);
    const ownedRoot=lstatSync(root);
    if (!ownedRoot.isDirectory() || ownedRoot.uid !== process.getuid() || (ownedRoot.mode & 0o077)) fail('resource-owner');
    // realpath cannot detect bind mounts of unrelated host data on the same device.
    const mountpoints=readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>{
      const point=line.split(' ')[4];
      if (!point) fail('mount-observation');
      return point.replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
    });
    if (mountpoints.some(p=>p === root || within(root,p))) fail('mounted-resource');
    if (!safePath(selectedEntry)) fail('entry-path');
    const walk = (p,dev) => {
      if (++count > 50000) fail('filesystem-bound');
      const s = lstatSync(p), id = `${s.dev}:${s.ino}`;
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || s.dev !== dev
          || (s.isFile() && s.nlink !== 1) || seen.has(id)) fail('unsafe-filesystem');
      seen.add(id);
      if(p===verificationRoot && verificationPin!==null) {if(id!==verificationPin||!s.isDirectory())fail('verification-replaced');return;}
      if (s.isDirectory()) for (const name of readdirSync(p)) {
        if (name === '.codex' || profile?.forbidden.includes(name)) fail('project-configuration');
        walk(join(p,name),dev);
      }
    };
    for (const p of all) {
      if (deleting && resources.includes(p) && !existsSync(p)) continue;
      checkPath(p); const s = lstatSync(p);
      if (!s.isDirectory()) fail('resource-directory');
      const identity = `${s.dev}:${s.ino}`;
      if (pins.has(p) && pins.get(p) !== identity) fail('resource-replaced');
      walk(p,s.dev); pins.set(p,identity);
    }
    // Only the selected member's file is mounted; no config, keychain or home mount.
    const auth = join(environment.loginSpace,profile?.authName ?? 'auth.json');
    return auth;
  }
  function loginFile(auth) {
    diagnostic='login-absent'; if (!existsSync(auth)) fail('login-absent');
    diagnostic='login-invalid'; const s=lstatSync(auth);
    if (!s.isFile() || s.nlink !== 1 || s.size === 0 || s.size > 65536) fail('login-invalid');
    diagnostic='login-denied'; const bytes=readFileSync(auth,'utf8');
    diagnostic='login-invalid'; if (profile) return profile.login(bytes);
    const value=JSON.parse(bytes);
    if (value.auth_mode !== 'chatgpt' || !value.tokens || typeof value.tokens.access_token !== 'string'
        || !value.tokens.access_token || value.OPENAI_API_KEY) fail('login-invalid');
    return Object.freeze(Object.values(value.tokens).filter(v=>typeof v === 'string' && v.length));
  }
  // Keep selected login material inside the transport. Check both the launch
  // credential and the current selected file at every evidence boundary.
  function assertVerificationInput(execution, value) {
    const s=states.get(execution);if(!s)fail('verification-unavailable');
    let secrets;
    try {secrets=[...s.secrets,...loginFile(physical())];}
    catch {fail('verification-credentials-unavailable');}
    const text=canonicalJSON(value);
    if(redactRuntimeText(text,secrets)!==text)throw Error('verification:credential-input');
  }
  const mount = (source,target,write=false) => ['--mount',
    `type=bind,src=${source},dst=${target},bind-propagation=rprivate,bind-recursive=disabled${write?'':',readonly'}`];
  function base(name, auth, credentialOutput=null) {
    return ['create','--name',name,'--label',`nibfin.execution=${name}`,'--pull','never','--platform','linux/amd64',
      '--read-only','--user','0:0','--no-healthcheck','--ipc','private','--cgroupns','private','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128',
      '--memory','1g','--cpus','2','--network',network.network,'--dns','127.0.0.1','--dns-search','.','--log-driver','none',
      '--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=1777','--workdir','/work',
      '--env','HOME=/tmp/home','--env',`NIBFIN_NODE_WORKLOAD=${egress?.node?'1':'0'}`,...(profile?.agent === 'claude' ? ['--env','CLAUDE_CONFIG_DIR=/tmp/home/.claude'] : profile ? [] : ['--env','CODEX_HOME=/tmp/home/.codex']),
      '--env','PATH=/usr/local/bin:/usr/bin:/bin',...imageEnvironment.flatMap(value=>['--env',value]),
      ...Object.entries(network.environment).flatMap(([key,value])=>['--env',`${key}=${value}`]),...brokerMounts(),...mount(auth,profile?.authTarget ?? '/auth/auth.json'),
      ...(credentialOutput?mount(credentialOutput,'/credential-update',true):[]),
      ...(durableSession?mount(durableSession.directory,'/tmp/home/.codex/sessions',true):[]),
      ...mount(selectedEntry,'/entry.mjs'),...mount(fileURLToPath(new URL('./agent-session.mjs',import.meta.url)),'/agent-session.mjs'),
      ...mount(fileURLToPath(new URL('./credential-output.mjs',import.meta.url)),'/credential-output.mjs'),
      ...(!profile?mount(fileURLToPath(new URL('./codex-credentials.mjs',import.meta.url)),'/codex-credentials.mjs'):[]),
      ...['readonly-tools.mjs','verification-runner.mjs','verification-prepare.mjs','node-verification.mjs','canonical.mjs','role-session.mjs'].flatMap(name=>mount(fileURLToPath(new URL('./'+name,import.meta.url)),'/'+name)),
      ...mount(fileURLToPath(new URL('./verification-child.mjs',import.meta.url)),'/verification-child.mjs'),
      ...mount(fileURLToPath(new URL('./verification-supervisor.py',import.meta.url)),'/verification-supervisor.py'),
      '--entrypoint','/usr/local/bin/node'];
  }
  async function inspect(s) {
    const data = await json(['inspect',s.name]);
    if (!Array.isArray(data) || data.length !== 1) throw Error();
    const c = data[0];
    if (c.Name !== '/' + s.name || c.Config?.Labels?.['nibfin.execution'] !== s.name || c.Image !== image
        || !c.State || typeof c.State.Running !== 'boolean' || !Number.isInteger(c.State.ExitCode)) throw Error();
    assertContainerConfiguration(c,s.arguments);
    if(JSON.stringify(c.Config.Cmd)!==JSON.stringify([image,'/entry.mjs',s.kind==='probe'?'probe':'execute'].slice(1)))throw Error('container-command');
    await network.verifyRole(c);
    return c;
  }
  async function missing(s) {
    const r = await command(['container','ls','--all','--no-trunc','--format','{{json .}}']);
    if (!r.ok) return false;
    try { return r.output.trim().split('\n').filter(Boolean).map(v=>JSON.parse(v))
      .every(c => typeof c.Names === 'string' && c.Names !== s.name); } catch { return false; }
  }
  async function remove(s) {
    try {
      if (s.absent) return true;
      if (s.pending) return false;
      if (await missing(s)) { s.absent = true; return true; }
      const c = await inspect(s);
      if (c.State.Running) return false;
      await command(['rm',s.name]);
      s.absent = await missing(s); return s.absent;
    } catch { return false; }
  }
  async function reserve(args, kind, record = ()=>{}) {
    const s = {name:'nibfin-'+randomUUID(), kind, absent:false, output:null, failed:false, launched:false};
    containers.set(s.name,s); record(s); // State survives a lost create response; never retry create/start.
    s.arguments=args(s.name);
    const r = await command(s.arguments);
    if (!r.ok) { s.failed = true; return s; }
    try { await inspect(s); } catch { s.failed=true; }
    return s;
  }
  function query(v) {
    const s = states.get(v.execution);
    if (!s || v.request !== s.request || v.environment !== environment.id || v.instance !== instanceId || v.agent !== agent) fail('query');
    return s;
  }
  const readinessResult = () => ({login:ready?'available':'unavailable',tool:ready?'available':'unavailable',
    isolation:ready?'verified':'unsupported',read:ready?'verified':'unsupported',write:ready?'verified':'unsupported',
    evidence:[`profile:${selectedProfile.id}`,`diagnostic:${diagnostic}`],
    limitations:[profile ? `${agent} native/model execution is Unverified; fixtures establish process contracts only` : 'Local fixtures do not establish measured native support; #121 owns native evidence']});
  function verificationEvidence(execution) {
      const state=states.get(execution);if(!state||state.pending)fail('verification-evidence-before-termination');
      physical();const directory=join(verificationRoot,'commands');if(!existsSync(directory))return [];
      if(realpathSync(directory)!==directory||!lstatSync(directory).isDirectory())fail('verification-evidence-directory');
      const names=readdirSync(directory);if(names.length>1000||names.includes('active.lock'))fail('verification-evidence-unresolved');
      const payloads=[];
      for(const name of names.filter(n=>n.endsWith('.json'))) {
        if(!/^[a-f0-9-]{36}\.json$/.test(name))fail('verification-evidence-name');
        const read=name=>{const path=join(directory,name),s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16777216)fail('verification-evidence-file');return readFileSync(path,'utf8');};
        const record=JSON.parse(read(name));
        if(!states.has(record.execution)||record.id+'.json'!==name||!['passed','failed','cancelled','budget_exhausted','spawn_failed','output-limit','output_error','unresolved'].includes(record.status))fail('verification-evidence-record');
        if(record.execution!==execution)continue;
        const log=read(record.id+'.log');
        if(!record.logDigest)fail('verification-evidence-log');
        if(createHash('sha256').update(log).digest('hex')!==record.logDigest)fail('verification-evidence-log');
        const payload={record,log};assertVerificationInput(execution,payload);
        const identity=bodyDigest(canonicalJSON(payload));if(!verificationRetained.has(identity))payloads.push({identity,payload});
      }
      return payloads;
    }
  return Object.freeze({
    diagnostic:()=>diagnostic,
    async readiness() {
      for(const s of states.values())if(s.credentialOwner&&!s.credentialsSettled&&!s.pending){
        try{if(!(await inspect(s)).State.Running){const settled=await s.credentialOwner.settle({successful:!s.failed&&s.output?.ok});
          s.secrets=[...new Set([...s.secrets,...settled.secrets])];s.credentialsSettled=settled.status==='completed';
          if(!s.credentialsSettled){diagnostic='login-reconciliation-required';return readinessResult();}}}catch{/* The existing probe still observes unavailable resources. */}
      }
      ready = false;workPhase=true;
      try {
        if (retired || process.platform !== 'linux' || process.arch !== 'x64') { diagnostic='unsupported-host'; return readinessResult(); }
        diagnostic='unsafe-mount'; const auth = physical(); loginFile(auth);
        diagnostic='runtime-unavailable';
        if (await json(['version','--format','{{json .Client.Version}}']) !== selectedProfile.docker) return readinessResult();
        const info = await json(['info','--format','{{json .}}']);
        assertDockerInfo(info);
        if (info.ServerVersion !== selectedProfile.docker || info.OSType !== 'linux' || info.Architecture !== 'x86_64'
            || info.CgroupVersion !== '2' || !['MemoryLimit','PidsLimit','CpuCfsQuota','CpuCfsPeriod'].every(k=>info[k] === true)
            || !info.SecurityOptions?.includes('name=rootless') || !info.SecurityOptions?.includes('name=seccomp,profile=builtin'))
          return readinessResult();
        diagnostic='image-mismatch'; const [im] = await json(['image','inspect',image]);
        if (im.Id !== image || im.Os !== 'linux' || im.Architecture !== 'amd64' || im.Config?.Volumes
            || !imageEnvironmentMatches(im.Config?.Env,imageLayout)) return readinessResult();
        diagnostic='cleanup-unresolved';
        for (const old of containers.values()) {
          if (old.kind === 'probe') { if (!await remove(old)) return readinessResult(); }
          else {
            // Collection still needs the owned container's terminal state. Retain role
            // containers until instance cleanup, even when another execution starts.
            if (old.pending) return readinessResult();
            try {
              const c = await inspect(old);
              if (c.State.Running || !['created','exited'].includes(c.State.Status)) return readinessResult();
            } catch { if (!await missing(old)) return readinessResult(); }
          }
        }
        diagnostic='egress-enforcement-unavailable';
        if (!network) return readinessResult();
        await network.ensure();
        diagnostic='probe-failed';
        const s = await reserve(name=>[...base(name,auth),image,'/entry.mjs','probe'],'probe');
        if (s.failed) return readinessResult();
        const r = await command(['start','--attach',s.name],25000,4096);
        const c = await inspect(s);
        if (c.State.Running || !await remove(s)) { diagnostic='cleanup-unresolved'; return readinessResult(); }
        if (!r.ok || c.State.ExitCode !== 0) return readinessResult();
        const p = JSON.parse(r.output);
        diagnostic='tool-mismatch';
        if (profile && p.diagnostic !== 'ready') {
          diagnostic=profile.diagnostics.includes(p.diagnostic)?p.diagnostic:'probe-failed'; return readinessResult();
        }
        if (p.version !== (profile?.version ?? selectedProfile.codex) || p.node !== selectedProfile.node || p.guest !== true
            || p.platform !== 'linux' || p.arch !== 'x64') return readinessResult();
        diagnostic='login-unavailable'; if (p.login !== true) return readinessResult();
        diagnostic='verification-supervisor-unavailable';if(p.verificationSupervisor!==true)return readinessResult();
        diagnostic='network-unprobed';
        const destinations=[...endpointProfiles[agent],...(egress.node?endpointProfiles['dependency-download']:[])];
        if(!Array.isArray(p.network)||p.network.length!==destinations.length||destinations.some(h=>!p.network.some(n=>n.hostname===h&&n.kind==='verified'))) {
          const denied=p.network?.find(n=>n.kind!=='verified');
          if(denied&&['policy-denial','dns','proxy','tls','timeout'].includes(denied.kind))diagnostic='network-'+denied.kind+(destinations.includes(denied.hostname)?':'+denied.hostname+':runner.v1.model-network':'');
          return readinessResult();
        }
        if ([...containers.values()].some(c=>c.kind === 'probe' && !c.absent)) { diagnostic='cleanup-unresolved'; return readinessResult(); }
        ready = true; diagnostic='ready';
      } catch { /* Fixed diagnostic above; never expose raw process or filesystem errors. */ }
      finally {workPhase=false;}
      return readinessResult();
    },
    async start(v) {
      workPhase=true;
      let credentialOwner=null;
      try {
      if (!ready || retired || states.has(v.execution)) fail('not-ready');
      ready = false;
      await network.ensure();
      const auth = physical(), e = v.executionIdentity, secrets = [...loginFile(auth)];
      if (v.environment !== environment.id || v.instance !== instanceId || v.agent !== agent
          || e.id !== v.execution || e.request !== v.request || (diagnosticMode ? e.role!=='rescue-diagnosis'||e.skill!=='rescue' : skillForRole(e.role) !== e.skill)
          || !same(v.workspace,{path:instance.workspace,access:e.role === 'deliver'?'write':'read'})
          || !same(v.agentLogin,{owner:environment.id,space:environment.loginSpace}) || !same(v.processEnvironment,{})
          || bodyDigest(v.instructions.content) !== v.instructions.identity || v.binding.instructions !== v.instructions.identity) fail('input');
      if (typeof v.instructions.content !== 'string' || Buffer.byteLength(v.instructions.content) > 1048576) fail('input-bound');
      const dir = join(scratch,randomUUID()); mkdirSync(dir,{recursive:true,mode:0o700});
      const input = join(dir,'input'); mkdirSync(input,{mode:0o700});
      writeFileSync(join(input,'instructions.md'),v.instructions.content,{flag:'wx',mode:0o400});
      const context = JSON.parse(canonicalJSON(task(e)));rejectSecrets({instructions:v.instructions,context},secrets);
      if (typeof context.prompt !== 'string' || !context.prompt.trim() || !context.inputs) fail('task');
      const shapeAuthor=context.outputFormat==='shape-author-v1';
      if(context.outputFormat!==undefined&&(!shapeAuthor||e.role!=='shape'||diagnosticMode))fail('output-format');
      const properties = diagnosticMode ? {outcome:{type:'string',enum:['ready','blocked']},failureClass:{type:'string',enum:['implementation_defect','external_failure','authority_gap','shape_defect']},body:{type:'string'},rootCause:{type:'string'},summary:{type:'string'},evidenceReferences:{type:'array',items:{type:'string'}},contractConflicts:{type:'array',maxItems:0,items:{type:'object',properties:{},required:[],additionalProperties:false}}} : {version:{type:'integer',enum:[1]},outcome:{type:'string',enum:outcomesForRole(e.role)},
        failureClass:{type:'string',enum:['none','implementation_defect','shape_defect','authority_gap','external_failure']},
        summary:{type:'string'},conflicts:{type:'array',items:{type:'object',additionalProperties:false,
          properties:Object.fromEntries(['scopeHash','shapeHash','scopeQuote','shapeQuote','evidenceReference'].map(k=>[k,{type:'string'}])),
          required:['scopeHash','shapeHash','scopeQuote','shapeQuote','evidenceReference']}}};
      const resultSchema={type:'object',properties,required:Object.keys(properties),additionalProperties:false};
      const schema=shapeAuthor?{type:'object',properties:{body:{type:'string'},result:resultSchema},required:['body','result'],additionalProperties:false}:resultSchema;
      writeFileSync(join(input,'schema.json'),JSON.stringify(schema),{flag:'wx',mode:0o400});
      if (profile?.prepare) profile.prepare(input,v.instructions.content,schema,v.workspace.access);
      const prompt = context.prompt+'\nRead-only Claude/Gemini roles: call nibfin MCP verify with file, args and cwd for the guarded lane, and github_read with native gh args and explicit --repo for broker reads. verify returns receipts/status; non-passed results are never passes. Verification discipline (all roles/customizations): use node /verification-runner.mjs -- <absolute executable> [arguments] for dependency preparation and regressions. It shares this execution deadline and a single command lane, retaining receipts/logs under /verification/commands. A busy, failed, cancelled, unresolved or budget_exhausted result is never a pass. Before Node regressions prepare a writable exact source copy: node /verification-runner.mjs -- node /verification-prepare.mjs /work /tmp [nested-project]. Reprepare after source changes; do not test stale copies. Preparation alone proves no test result. Independent Acceptance and CI remain required.';

      if (Buffer.byteLength(prompt) > 524288 || Buffer.byteLength(JSON.stringify(context.inputs)) > 262144) fail('input-bound');
      const remaining=Math.min(timeout,deadlineAt-reserveMs-Date.now());if(remaining<=0)fail('budget-exhausted');
      const commandStartedAt=Date.now(),commandBudget={...verificationBudget(deadlineAt-commandStartedAt,commandStartedAt,reserveMs),execution:e.id};
      writeFileSync(join(input,'verification-budget.json'),JSON.stringify(commandBudget),{flag:'wx',mode:0o400});
      writeFileSync(join(input,'verification-paths.json'),JSON.stringify([{from:instance.workspace,to:'/work'},{from:verificationRoot,to:'/verification'}]),{flag:'wx',mode:0o400});
      writeFileSync(join(input,'request.json'),JSON.stringify({access:v.workspace.access,prompt,timeout:remaining,
        deadlineAt:deadlineAt-reserveMs,...(recovery?{recovery}:{}),
        ...(durableSession?{sessionOutput:'/verification/role-session.json',...(durableSession.id?{resume:{id:durableSession.id,memberId:durableSession.memberId}}:{})}:{}),
        githubRead:readRepositories?{repositories:readRepositories}:null,
        verificationPolicy:{runner:'/verification-runner.mjs',maxConcurrent:1,budget:commandBudget,evidenceDirectory:'/verification/commands'},
        context:{version:1,stage:e.role,execution:e,binding:v.binding,inputs:context.inputs,
          ...(shapeAuthor?{outputFormat:'shape-author-v1'}:{}),...(durableSession?{memberId:durableSession.memberId}:{})}}),{flag:'wx',mode:0o400});
      mkdirSync(verificationRoot,{recursive:true,mode:0o700});
      const verificationStat=lstatSync(verificationRoot);if(!verificationStat.isDirectory()||verificationStat.isSymbolicLink())fail('verification-root');
      verificationPin=`${verificationStat.dev}:${verificationStat.ino}`;
      if(!profile){const credentialRoot=join(dir,'credentials');mkdirSync(credentialRoot,{mode:0o700});
        credentialOwner=await prepareCodexCredentials({login:auth,root:credentialRoot,execution:e.id,deadlineAt});
        secrets.push(...loginFile(credentialOwner.source));rejectSecrets({instructions:v.instructions,context},secrets);}
      const s = await reserve(name=>[...base(name,credentialOwner?.source??auth,credentialOwner?.output),...mount(verificationRoot,'/verification',true),...mount(instance.workspace,'/work',e.role === 'deliver'),
        ...mount(input,'/input'),image,'/entry.mjs','execute'],'role',s=>{
          Object.assign(s,{request:v.request,dir,secrets,credentialOwner}); states.set(v.execution,s); });
      if (s.failed) throw Error('codex:start-unresolved');
      s.launched = true;
      credentialOwner?.markLaunched();
      // Attach is a tracked promise, not a detached host process. Timeout kills only the CLI;
      // container inspection and stop are still required before reuse/cleanup.
      s.pending = command(['start','--attach',s.name],Math.min(timeout+5000,deadlineAt-Date.now())).then(r=>{s.output=r;s.pending=null;});
      return {status:'started'};
      } catch {
        if(credentialOwner&&!states.has(v.execution))await credentialOwner.settle();
        if (states.has(v.execution)) throw Error('codex:start-unresolved');
        return {status:'rejected'};
      } finally {workPhase=false;}
    },
    async collect(v) {
      const s=query(v); let c;
      try { c=await inspect(s); } catch {
        return !s.pending && await missing(s) ? {status:'complete',exitCode:1,evidence:null} : {status:'pending',exitCode:null,evidence:null};
      }
      if (c.State.Running || s.pending) return {status:'pending',exitCode:null,evidence:null};
      if(s.credentialOwner){
        const authResult=await s.credentialOwner.settle({successful:!s.failed&&s.output?.ok&&c.State.ExitCode===0});
        s.secrets=[...new Set([...s.secrets,...authResult.secrets])];
        s.credentialsSettled=authResult.status==='completed';
        if(authResult.status!=='completed'){diagnostic='login-reconciliation-required';return{status:'complete',exitCode:1,evidence:null};}
      }
      let evidence = null;
      if (!s.failed && (!s.output?.ok || c.State.ExitCode !== 0)) {
        diagnostic='provider-failure';
        try {
          const failure=JSON.parse(s.output.output);
          if (Object.keys(failure).join(',') === 'diagnostic' && ['login-rejected','provider-failure','invalid-result','capacity-exhausted','budget-exhausted'].includes(failure.diagnostic))
            diagnostic=failure.diagnostic;
        } catch { /* Never forward raw CLI output. */ }
      }
      if (!s.failed && s.output?.ok && c.State.ExitCode === 0) { try {
        const parsed=JSON.parse(s.output.output), pending=[parsed];rejectSecrets(parsed,s.secrets);
        while (pending.length) {
          const value=pending.pop();
          if (typeof value === 'string' && s.secrets.some(secret=>value.includes(secret))) throw Error('credential-output');
          if (value && typeof value === 'object') for (const [key,item] of Object.entries(value)) pending.push(key,item);
        }
        evidence=parsed;
      } catch {} }
      if(evidence&&durableSession) {
        const session=JSON.parse(readFileSync(join(verificationRoot,'role-session.json'),'utf8'));
        if(session.execution!==v.execution||session.memberId!==durableSession.memberId||session.adapter!=='codex'||durableSession.id&&session.id!==durableSession.id)fail('session-observation');
        delete evidence.memberId;
      }
      return {status:'complete',exitCode:s.failed || !s.output?.ok ? 1 : c.State.ExitCode,evidence};
    },
    async sessionEvidence(execution) {
      const state=states.get(execution);
      if(!durableSession||!state||state.pending||(await inspect(state)).State.Running)fail('session-unavailable');
      const value=JSON.parse(readFileSync(join(verificationRoot,'role-session.json'),'utf8'));
      if(value.execution!==execution||value.memberId!==durableSession.memberId||value.adapter!=='codex')fail('session-observation');
      return {...value,directory:durableSession.directory};
    },
    assertVerificationInput,
    assertCandidate(execution) {
      const state=states.get(execution);if(!state)fail('candidate-execution');
      const secrets=[...state.secrets,...loginFile(physical())];
      let bytes=0;const walk=path=>{const stat=lstatSync(path);if(stat.isDirectory()){for(const name of readdirSync(path)){if(name!=='.git')walk(join(path,name));}}
        else if(stat.isFile()){if(stat.size>16777216||(bytes+=stat.size)>134217728)fail('candidate-bound');const text=readFileSync(path,'utf8');if(redactRuntimeText(text,secrets)!==text)fail('candidate-credential');}};
      walk(instance.workspace);return {status:'verified'};
    },
    async verificationProcess(execution, commandInput) {
      const {signal:ignoredSignal,...inputEvidence}=commandInput;
      assertVerificationInput(execution,inputEvidence);
      const s=states.get(execution);
      if(!s||s.verificationUnresolved||s.verificationBusy||!egress?.node)fail('verification-unavailable');
      s.verificationBusy=true;
      let cancelled=false,cancellation=null;
      const abort=()=>{if(cancelled)return;cancelled=true;cancellation=command(['stop','--time','2',s.name],10000);};
      commandInput.signal?.addEventListener('abort',abort,{once:true});
      if(commandInput.signal?.aborted)abort();
      try {
        if(cancelled){await cancellation;return {status:'cancelled',exitCode:null,signal:null,log:''};}
        const c=await inspect(s);if(!c.State.Running)fail('verification-not-running');
        physical();
        const translate=value=>{
          if(typeof value!=='string')return value;
          if(value===verificationRoot||value.startsWith(verificationRoot+'/'))return '/verification'+value.slice(verificationRoot.length);
          if(value===instance.workspace||value.startsWith(instance.workspace+'/'))return '/work'+value.slice(instance.workspace.length);
          return value;
        };
        const input={file:commandInput.file,args:commandInput.args.map(translate),cwd:translate(commandInput.cwd),
          timeoutMs:Math.min(commandInput.timeoutMs,deadlineAt-reserveMs-Date.now()),
          env:Object.fromEntries(Object.entries(commandInput.env).map(([k,v])=>[k,translate(v)]))};
        if(!input.cwd.startsWith('/verification/')||resolve(input.cwd)!==input.cwd||input.timeoutMs<=0)fail('verification-input');
        // Proxy configuration is selected by the transport, not a checkout/npmrc.
        Object.assign(input.env,network.environment,{NODE_USE_ENV_PROXY:'1'});
        const response=await command(['exec','--user','0:0',s.name,'/usr/local/bin/node','/verification-runner.mjs','--protocol',JSON.stringify(input)],input.timeoutMs+5000,2097152);
        if(cancelled) {
          await cancellation;const ended=await inspect(s);
          if(ended.State.Running){s.verificationUnresolved=true;return {status:'unresolved',exitCode:null,signal:null,log:''};}
          return {status:'cancelled',exitCode:null,signal:null,log:''};
        }
        if(!response.ok){s.verificationUnresolved=true;return {status:'unresolved',exitCode:null,signal:null,log:''};}
        const result=JSON.parse(response.output);
        if(result.status==='unresolved')s.verificationUnresolved=true;
        result.log=redactRuntimeText(result.log,[...s.secrets,...loginFile(physical())]);return result;
      }catch{s.verificationUnresolved=true;return {status:'unresolved',exitCode:null,signal:null,log:''};}
      finally{commandInput.signal?.removeEventListener('abort',abort);if(cancellation)await cancellation;s.verificationBusy=false;}
    },
    verificationEvidence,
    acknowledgeVerification(identities) {for(const identity of identities){if(!/^[a-f0-9]{64}$/.test(identity))fail('verification-evidence-identity');verificationRetained.add(identity);}},
    verificationRoot:()=>verificationRoot,
    async stop(v) {
      const s=query(v);
      try { await inspect(s); } catch { return {status:'unknown'}; }
      const r=await command(['stop','--time','2',s.name],10000);
      return {status:r.ok?'requested':'unknown'};
    },
    async termination(v) {
      const s=query(v);
      try { const c=await inspect(s); return {status:s.pending?'unknown':c.State.Running?'running':c.State.Status === 'exited' || c.State.Status === 'created'?'terminated':'unknown'}; }
      catch { return {status:!s.pending && await missing(s)?'terminated':'unknown'}; }
    },
    async cleanup(v) {
      if (!same(v.resources,resources) || v.environment !== environment.id || v.instance !== instanceId) fail('cleanup');
      try{
      for(const s of states.values())if(s.credentialOwner&&!s.credentialsSettled){
        if(s.pending)return{status:'unresolved',residuals:resources};
        if(s.launched)try{if((await inspect(s)).State.Running)return{status:'unresolved',residuals:resources};}catch{if(!await missing(s))return{status:'unresolved',residuals:resources};}
        const authResult=await s.credentialOwner.settle({successful:!s.failed&&s.output?.ok});
        s.credentialsSettled=authResult.status==='completed';
        if(authResult.status!=='completed')return{status:'unresolved',residuals:resources};
      }
      try {for(const execution of states.keys())if(verificationEvidence(execution).length)return {status:'unresolved',residuals:resources};}catch{return {status:'unresolved',residuals:resources};}
      for (const s of containers.values()) if (!await remove(s)) return {status:'unresolved',residuals:resources};
      if (network && (await network.cleanup()).status !== 'completed') return {status:'unresolved',residuals:resources};
      try {
        physical(); deleting=true;
        for (const p of resources) rmSync(p,{recursive:true,force:true});
        const residuals=resources.filter(existsSync);
        if (residuals.length) return {status:'failed',residuals};
        retired=true;return {status:'completed',residuals:[]};
      } catch { return {status:'failed',residuals:resources.filter(existsSync)}; }
      }finally{for(const s of states.values())await s.credentialOwner?.releaseLease();}
    }
  });
}
