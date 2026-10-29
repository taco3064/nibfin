import {verifyRepositoryIdentity} from './collaboration.mjs';
import {createActionsVerifier, createSyntheticActionsVerifierForTest, verifyNativeNeeds} from './actions.mjs';
import {createGithubProvider, localGhTransport, publicDiagnostic, githubEndpointPermission} from './provider.mjs';
import {createAuthorizationBoundary} from './authorization.mjs';
import {verifyGrant} from './grants.mjs';
import {githubId, repositoryCoordinates, canonicalJSON} from './index.mjs';
import {poolLogicalTarget,poolInventoryRead,validatePoolDispatch,poolDispatchAccess} from './execution-pool.mjs';

const need = ok => {if (!ok) throw Error('host-identity:configuration');};
const fail = kind => ({outcome:'failed',diagnostic:{kind}});
const account = a => a && typeof a.login==='string' && /^[a-zA-Z0-9-]{1,39}$/.test(a.login)
  && typeof a.id==='string' && /^[1-9][0-9]*$/.test(a.id);
const isMember = mode => ['execute','compute'].includes(mode);
const exact = (v,required,optional=[]) => need(v && Object.getPrototypeOf(v)===Object.prototype
  && required.every(k=>Object.hasOwn(v,k)) && Reflect.ownKeys(v).every(k=>typeof k==='string'
    && [...required,...optional].includes(k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value')));

/** Protected App/Workflow token acquisition only. Metadata is an upper bound from
 * trusted issuance configuration; GitHub still enforces actual endpoint rights.
 * No token, response body or fetch exception is exposed as a diagnostic. */
export function hostedGithubTransport({getCredential, repository, repositoryId, organization, operatorId, now=Date.now, fetcher=fetch,executionPool,poolDispatch}={}) {
  need(typeof getCredential==='function' && typeof now==='function' && typeof fetcher==='function');
  githubId(repositoryId);
  need(repositoryCoordinates(...repository.split('/')).key===repository);
  need(organization===undefined || organization===repository.split('/')[0]);
  const pool=executionPool===undefined?null:poolLogicalTarget(executionPool,{repository,repositoryId});
  const dispatchPolicy=poolDispatch===undefined?null:validatePoolDispatch(pool,poolDispatch);
  need(!dispatchPolicy||dispatchPolicy.repository===repository&&dispatchPolicy.repositoryId===repositoryId);
  const dispatch = async (request, credential, prepared=false) => {
    try {
      if(typeof request.endpoint!=='string' || !/^\/(?:[A-Za-z0-9_./?=&-]|%[0-9A-Fa-f]{2})+$/.test(request.endpoint)
        || new URL(request.endpoint,'https://api.github.com').pathname+new URL(request.endpoint,'https://api.github.com').search!==request.endpoint
        || request.endpoint.includes('//'))return {status:403,body:'{}'};
      const repoPrefix='/repos/'+repository;
      const orgPrefix=organization && '/orgs/'+organization;
      const right=githubEndpointPermission(request.method,request.endpoint);
      const poolRead=pool&&poolInventoryRead(pool,request);
      const poolOperation=dispatchPolicy&&poolDispatchAccess(pool,dispatchPolicy,request);
      const scoped=poolRead||poolOperation||request.endpoint===repoPrefix || request.endpoint.startsWith(repoPrefix+'/')
        || orgPrefix && (request.endpoint===orgPrefix || request.endpoint.startsWith(orgPrefix+'/'))
        || /^\/users\/[A-Za-z0-9-]+$/.test(request.endpoint);
      if (!right || !scoped) return {status:403,body:'{}'};
      const c=prepared?credential:await getCredential();
      if(request.signal?.aborted)return {failure:'transport'};
      if (!c || typeof c.token!=='string' || !/^[A-Za-z0-9_.-]{1,4096}$/.test(c.token)
        || !Number.isSafeInteger(c.expiresAt) || c.expiresAt<=now()
        || operatorId!==undefined && c.installationId!==operatorId
        || !Array.isArray(c.repositoryIds) || !c.repositoryIds.includes(repositoryId)
        ||(poolRead||poolOperation)&&!c.repositoryIds.includes(pool.source.repositoryId)) return {failure:'authentication'};
      if (right!=='public:read') {
        const [name,level]=right.split(':');
        if (name.startsWith('organization_') && c.organization!==organization) return {status:403,body:'{}'};
        if (!(c.permissions?.[name]==='write' || level==='read' && c.permissions?.[name]==='read')) return {status:403,body:'{}'};
      }
      // Only the official artifact ZIP endpoint may redirect. Its signed storage
      // URL is returned to artifactArchiveTransport, which downloads without any
      // credential. All other authenticated endpoints retain redirect rejection.
      const artifactZip=request.method==='GET'&&/^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/[1-9][0-9]*\/zip$/.test(request.endpoint);
      // Address, headers, redirect and credentials policy cannot come from request input.
      const response=await fetcher('https://api.github.com'+request.endpoint,{method:request.method,
        headers:{...request.headers,Authorization:'Bearer '+c.token},body:request.body,
        signal:request.signal,redirect:artifactZip?'manual':'error',credentials:'omit'});
      if (response.url!=='https://api.github.com'+request.endpoint) return {failure:'transport'};
      if(artifactZip&&response.status===302) {
        await response.body?.cancel();
        return {status:302,headers:{location:response.headers.get('location')},body:''};
      }
      const reader=response.body?.getReader();
      if (!reader) return {failure:'malformed'};
      let bytes=0;const chunks=[];
      try {
        for (;;) {
          const {done,value}=await reader.read();if(done)break;
          bytes+=value.length;if(bytes>8*1024*1024)return {failure:'malformed'};chunks.push(value);
        }
      } finally {await reader.cancel();}
      return {status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.concat(chunks).toString()};
    } catch {return {failure:'transport'};}
  };
  const transport = request => dispatch(request);
  // A request-local closure keeps credentials inside this transport. Acquisition
  // finishes before the provider's final authorization; dispatch never reacquires.
  Object.defineProperty(transport,'prepareMutation',{value:async () => {
    const credential=structuredClone(await getCredential());
    return request=>dispatch(request,credential,true);
  }});
  return Object.freeze(transport);
}

function compose(configuration, testFacility) {
  exact(configuration,['options','mode','source','api','operations'],['now','authorization']);
  need(configuration.mode==='registration'||configuration.authorization!==undefined);
  exact(configuration.source,['policy','getToken','continuation'],['getAssociation','timeoutMs']);
  exact(configuration.api,['kind','operator'],['executable','getCredential','organization','poolDispatch']);
  if(configuration.mode!=='registration')exact(configuration.authorization,['getCheckpoint','maxCheckpointMs']);
  const options=structuredClone(configuration.options),mode=configuration.mode,source={...configuration.source},
    api={...configuration.api,operator:{...configuration.api?.operator}},authorization={...configuration.authorization},now=configuration.now??Date.now;
  need(typeof now==='function' && ['lookup','resolve','execute','compute','wake','registration','rescue'].includes(mode));
  exact(options,['version','repository','repositoryId','environment','authentication'],['groupId','routing','executionPool']);
  need(options.version===1 && options.environment===(isMember(mode)?'nibfin-member':'nibfin-hosted'));
  need(options?.authentication==='actions-oidc' && account(api.operator));
  if(Object.hasOwn(options,'routing'))need(options.routing==='authenticated'
    &&(['resolve','execute','compute'].includes(mode)||mode==='lookup'&&options.executionPool!==undefined));
  githubId(options.repositoryId);
  need(repositoryCoordinates(...options.repository.split('/')).key===options.repository);
  const pool=options.executionPool===undefined?null:poolLogicalTarget(options.executionPool,options);
  if(pool)need(options.routing==='authenticated'&&['lookup','resolve','execute','compute'].includes(mode)&&options.groupId===undefined);
  exact(source,['policy','getToken','continuation'],['getAssociation','timeoutMs']);
  need(typeof source.getToken==='function' && (source.getAssociation===undefined || typeof source.getAssociation==='function'));
  const timeoutMs=source.timeoutMs??30000;
  need(Number.isInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=30000);
  // Snapshot policy, never derive it from events/environment or the JWT itself.
  const policy=structuredClone(source.policy),continuation={...source.continuation};
  need(policy && policy.repository_visibility==='public' && typeof policy.repository==='string'
    && policy.workflow_ref?.startsWith(policy.repository+'/.github/workflows/'));
  githubId(policy.repository_id);githubId(policy.run_id);githubId(policy.run_attempt);
  if(pool)need(policy.repository===pool.source.repository&&policy.repository_id===pool.source.repositoryId
    &&policy.repository_owner_id===pool.source.ownerId);
  need(!Object.hasOwn(policy,'now'));
  need(['none','native-needs','cross-run'].includes(continuation.kind));
  exact(continuation,['kind'],continuation.kind==='none'?[]:continuation.kind==='native-needs'?['expected','getEvidence']
    :['policy','current','consumerExecution','maxAge','getEvidence']);
  const priorPolicy=continuation.kind==='cross-run'?structuredClone(continuation.policy):null;
  const priorCurrent=continuation.kind==='cross-run'?structuredClone(continuation.current):null;
  const nativeExpected=continuation.kind==='native-needs'?structuredClone(continuation.expected):null;
  if(continuation.kind!=='none')need(typeof continuation.getEvidence==='function');
  need(api.kind===(isMember(mode)?'local':'hosted'));
  exact(api,api.kind==='local'?['kind','operator']:['kind','operator','getCredential'],
    api.kind==='local'?['executable','organization']:['organization','poolDispatch']);
  const dispatchPolicy=api.poolDispatch===undefined?null:validatePoolDispatch(pool,api.poolDispatch);
  need(!dispatchPolicy||dispatchPolicy.repository===options.repository&&dispatchPolicy.repositoryId===options.repositoryId);
  if(api.kind==='hosted')need(typeof api.getCredential==='function');
  if(api.organization!==undefined)need(api.organization===options.repository.split('/')[0]);
  if(mode!=='registration'){need(typeof authorization?.getCheckpoint==='function');
    exact(authorization,['getCheckpoint','maxCheckpointMs']);}
  const operations=structuredClone(configuration.operations);
  need(Array.isArray(operations));
  for(const operation of operations) {
    exact(operation,['method','endpoint','target','operation']);githubId(operation.target);
    const right=githubEndpointPermission(operation.method,operation.endpoint);
    const dispatchEndpoint=dispatchPolicy&&operation.operation==='dispatch'&&operation.method==='POST'
      &&operation.target===dispatchPolicy.workflow&&operation.endpoint===`/repos/${pool.source.repository}/actions/workflows/${dispatchPolicy.workflow}/dispatches`;
    need(right && (dispatchEndpoint||dispatchPolicy&&poolDispatchAccess(pool,dispatchPolicy,operation)
      ||pool&&poolInventoryRead(pool,operation)||operation.endpoint==='/repos/'+options.repository || operation.endpoint.startsWith('/repos/'+options.repository+'/')
      || /^\/users\/[A-Za-z0-9-]+$/.test(operation.endpoint)
      || api.organization && (operation.endpoint==='/orgs/'+api.organization || operation.endpoint.startsWith('/orgs/'+api.organization+'/'))));
  }
  const verifier=testFacility?createSyntheticActionsVerifierForTest(testFacility.jwks):createActionsVerifier();
  const transport=testFacility?.transport ?? (api.kind==='local'?localGhTransport({executable:api.executable})
    :hostedGithubTransport({getCredential:api.getCredential,repository:options.repository,
      repositoryId:options.repositoryId,organization:api.organization,operatorId:api.operator.id,now,
      ...(pool?{executionPool:pool}:{}),...(dispatchPolicy?{poolDispatch:dispatchPolicy}:{})}));
  const identity=api.kind==='local'?'local-stored-login':'hosted-authorized';
  const reader=createGithubProvider({transport,identity,now});
  const getCheckpoint=authorization.getCheckpoint;
  // Authentication uses whole seconds and accepts age equal to maxAge+tolerance.
  // Preserve that exact upper boundary through all later awaited authorization reads.
  const freshnessDeadline=(verified,expected)=>Math.min(verified.expiresAt*1000,
    (Math.floor(verified.issuedAt+expected.maxAge+expected.tolerance)+1)*1000);
  let sourceDeadline=0;
  const sourceFresh=()=>{const current=now();return Number.isSafeInteger(current) && current<sourceDeadline;};
  const boundaryFor=member=>createAuthorizationBoundary({transport,identity,now,maxCheckpointMs:authorization.maxCheckpointMs,
    // No awaited source/provider work after the final Grant checkpoint.
    beforeMutation:intent=>sourceFresh() && !intent.signal?.aborted,
    getCheckpoint:async intent=>{
      const c=structuredClone(await getCheckpoint(intent));
      need(c.request.repository.id===options.repositoryId && c.request.repository.name===options.repository
        && (intent.operation===undefined || c.request.operation===intent.operation));
      // API operator identity is protected configuration, never an embedding assertion.
      if(member)c.member=structuredClone(member);
      c.operator=api.kind==='local'?{...api.operator}:{id:api.operator.id,kind:'service',source:identity,trusted:true};
      return c;
    }});
  const boundary=mode==='registration'?null:boundaryFor(options.routing==='authenticated'&&isMember(mode)?api.operator:undefined);
  async function authenticated(argument) {
    try {
      const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(argument.signal?[argument.signal]:[])]);
      const wait=async call=>{
        need(!signal.aborted);
        let abort;
        try {return await Promise.race([call(),new Promise((_,reject)=>{
          abort=()=>reject(Error('host-identity:timeout'));signal.addEventListener('abort',abort,{once:true});
          if(signal.aborted)abort();
        })]);} finally {if(abort)signal.removeEventListener('abort',abort);}
      };
      const c=argument.context;
      need(argument.mode===mode && c.repository===options.repository && c.repositoryId===options.repositoryId
        && c.run.id===policy.run_id && c.run.attempt===policy.run_attempt
        && (c.eventName===undefined || c.eventName===policy.event_name) && !argument.signal?.aborted);
      const token=await wait(()=>source.getToken({signal,audience:policy.audience}));
      const association=await wait(()=>source.getAssociation?.({signal}));
      const seconds=Math.floor(now()/1000);
      const sourceResult=await verifier.authenticate(token,{...policy,now:seconds},association);
      need(sourceResult.ok && sourceResult.synthetic===Boolean(testFacility));
      let deadline=freshnessDeadline(sourceResult,policy);
      if(continuation.kind==='native-needs') {
        need(nativeExpected.runId===policy.run_id && nativeExpected.attempt===policy.run_attempt
          && nativeExpected.repositoryId===policy.repository_id && nativeExpected.workflow===policy.workflowDigest);
        need(verifyNativeNeeds({...await wait(()=>continuation.getEvidence({signal})),expected:nativeExpected}).ok);
      } else if(continuation.kind==='cross-run') {
        const e=await wait(()=>continuation.getEvidence({signal}));
        const previous=await verifier.authenticate(e.token,{...priorPolicy,now:seconds},e.association);
        need(verifier.predecessor({source:previous,receipt:e.receipt,current:priorCurrent,
          now:seconds,maxAge:continuation.maxAge,recordedAt:e.recordedAt,
          consumerExecution:continuation.consumerExecution}).ok);
        deadline=Math.min(deadline,freshnessDeadline(previous,priorPolicy),(Math.floor(e.recordedAt+continuation.maxAge)+1)*1000);
        need(priorPolicy.run_id!==policy.run_id); // cross-Run proof cannot be local needs
      }
      if(api.kind==='local') {
        const operator=await reader.request({endpoint:'/user',operation:'identity',target:options.repositoryId,
          correlation:'host_identity',signal});
        if(operator.outcome!=='read')return {ok:false,...publicDiagnostic(operator)};
        need(operator.data?.id===api.operator.id && operator.data.login?.toLowerCase()===api.operator.login.toLowerCase());
      }
      const target=await reader.request({endpoint:'/repos/'+options.repository,target:options.repositoryId,
        operation:'identity',correlation:'host_identity',signal});
      if(target.outcome!=='read')return {ok:false,...publicDiagnostic(target)};
      need(!signal.aborted);
      const t=target.data;
      verifyRepositoryIdentity(t,pool?.targets.find(v=>v.repositoryId===options.repositoryId)
        ??{version:1,repository:options.repository,repositoryId:options.repositoryId});
      if(pool){
        const executionSource=await reader.request({endpoint:'/repos/'+pool.source.repository,target:options.repositoryId,
          operation:'identity',correlation:'host_execution_source',signal});
        need(executionSource.outcome==='read');verifyRepositoryIdentity(executionSource.data,pool.source);
      }
      sourceDeadline=deadline;need(sourceFresh());
      return {ok:true,identity:{repository:options.repository,repositoryId:options.repositoryId,
        visibility:'public',ownership:t.owner.type==='User'?'personal':'organization',run:{id:policy.run_id,attempt:policy.run_attempt}},
        ...(policy.job==='required' && policy.runner==='required' && policy.runner_environment==='self-hosted'
          ? {runnerId:policy.runnerId} : {})};
    } catch {return {ok:false,diagnostic:{kind:'source_or_identity_rejected'}};}
  }
  const boundArgument=()=>({mode,context:{repository:options.repository,repositoryId:options.repositoryId,
    run:{id:policy.run_id,attempt:policy.run_attempt}}});
  async function eligibility(intent={},settings={}) {
    if(mode==='registration')return {ok:false,diagnostic:{kind:'unsupported'}};
    const auth=await authenticated({...boundArgument(),signal:settings.signal});
    if(!auth.ok)return auth;
    const result=await boundary.eligibility(intent,settings);
    return result.ok && !sourceFresh()?{ok:false,diagnostic:{kind:'source_expired'}}:result;
  }
  async function memberEligibility(member,intent,settings={}) {
    if(mode==='registration')return {ok:false,diagnostic:{kind:'unsupported'}};
    if(!account(member))return fail('member');
    const auth=await authenticated({...boundArgument(),signal:settings.signal});
    if(!auth.ok)return auth;
    const result=await boundaryFor(member).eligibility(intent,settings);
    return sourceFresh()?result:{ok:false,diagnostic:{kind:'source_expired'}};
  }
  const permitted = r => !Object.keys(r).some(k=>!['method','endpoint','target','operation','correlation','body','context','signal','expectedId'].includes(k))
    && githubEndpointPermission(r.method??'GET',r.endpoint)!==null
    && operations.some(o=>['method','target','operation'].every(k=>o[k]===(k==='method'?(r[k]??'GET'):r[k]))
      && (o.endpoint===r.endpoint || (r.method??'GET')==='GET' && o.endpoint===r.endpoint.split('?')[0]));
  async function managementRight(r) {
    if(api.kind!=='local' || !/^(administration|organization_self_hosted_runners):/.test(githubEndpointPermission(r.method??'GET',r.endpoint)))return null;
    const org=r.endpoint.startsWith('/orgs/');
    const managementRepository=pool&&poolInventoryRead(pool,r)?pool.source.repository:options.repository;
    const check=await reader.request({endpoint:org?'/user/memberships/orgs/'+api.organization:'/repos/'+managementRepository,
      operation:r.operation,target:options.repositoryId,correlation:r.correlation,signal:r.signal});
    if(check.outcome!=='read')return publicDiagnostic(check);
    return (org?check.data?.state==='active'&&check.data?.role==='admin':check.data?.permissions?.admin===true)?null:fail('denied');
  }
  // Resolve cannot require a chosen member before reading the candidates. This
  // read-only path requires authenticated source + signed Grant; the maintained
  // selector separately applies boundaryFor(member) before selecting anyone.
  async function routingEligibility(intent={},settings={}) {
    try {
      need(options.routing==='authenticated');
      const startedAt=now(),auth=await authenticated({...boundArgument(),signal:settings.signal});
      if(!auth.ok)return auth;
      const c=structuredClone(await getCheckpoint(Object.freeze({...intent})));
      need(c.request.repository.id===options.repositoryId && c.request.repository.name===options.repository
        &&(intent.operation===undefined||c.request.operation===intent.operation));
      const observedAt=now();
      need(verifyGrant(c.grant,{...c.grantContext,request:c.request,now:observedAt}).ok
        &&sourceFresh()&&!settings.signal?.aborted&&Number.isSafeInteger(startedAt)
        &&Number.isSafeInteger(observedAt)&&observedAt>=startedAt
        &&observedAt-startedAt<authorization.maxCheckpointMs);
      return {ok:true,observation:{source:identity,repositoryId:options.repositoryId,issueId:c.request.issueId,
        operation:c.request.operation,startedAt,observedAt}};
    } catch {return {ok:false,diagnostic:{kind:'routing_authority_rejected'}};}
  }
  const routingReader=createGithubProvider({transport,identity,now,authorizeRead:async r=>
    options.routing==='authenticated'&&permitted(r)&&(await routingEligibility(r,{signal:r.signal})).ok
      &&!(await managementRight(r))&&sourceFresh()});
  const routing=Object.freeze({eligibility:routingEligibility,provider:Object.freeze({
    request:async r=>{
      if((r?.method??'GET')!=='GET')return fail('unsupported');
      const result=await routingReader.request(r);return sourceFresh()?result:fail('source_expired');
    },collection:async r=>{
      if((r?.method??'GET')!=='GET')return {outcome:'incomplete',diagnostic:{kind:'unsupported'}};
      const result=await routingReader.collection(r);
      return sourceFresh()?result:{outcome:'incomplete',diagnostic:{kind:'source_expired'}};
    }
  })});
  async function request(r) {
    if(mode==='registration'||!r || !permitted(r))return fail('unsupported');
    const auth=await authenticated({...boundArgument(),signal:r.signal});
    if(!auth.ok)return {...publicDiagnostic(auth),outcome:'failed'};
    // Reads of management endpoints also require the current member/Grant checkpoint.
    const intent={...r};if((r.method??'GET')==='GET')delete intent.method;
    const eligible=await boundary.eligibility(intent,{signal:r.signal});
    if(!eligible.ok)return {...publicDiagnostic(eligible),outcome:'failed'};
    const right=await managementRight(r);if(right)return right;
    if(!sourceFresh())return fail('source_expired');
    return boundary.request(r);
  }
  // A registration request is independently captured by the protected dispatch
  // integration and pinned in deployment configuration. Event JSON cannot set it.
  async function registrationSource({expected,input,context,signal}) {
    need(mode==='registration' && policy.repository===options.repository
      &&policy.repository_id===options.repositoryId&&policy.event_name==='workflow_dispatch');
    const result=await authenticated({mode,context,signal});need(result.ok);
    exact(expected,['input','requester']);exact(expected.requester,['id','login']);
    need(account(expected.requester)&&expected.requester.id===policy.actor_id
      &&canonicalJSON(input)===canonicalJSON(expected.input));
    const run=await reader.request({endpoint:`/repos/${options.repository}/actions/runs/${policy.run_id}/attempts/${policy.run_attempt}`,
      target:options.repositoryId,operation:'registration',correlation:input.nibfin_registration,signal});
    const r=run.data;
    need(run.outcome==='read'&&r.id===policy.run_id&&String(r.run_attempt)===policy.run_attempt
      &&r.repository?.id===options.repositoryId&&r.event==='workflow_dispatch'
      &&r.actor?.id===expected.requester.id&&r.actor?.login?.toLowerCase()===expected.requester.login.toLowerCase()
      &&r.head_sha===policy.workflow_sha&&sourceFresh()&&!signal?.aborted);
    return {authenticated:true,event:'workflow_dispatch',requestId:input.nibfin_registration,
      publicKey:input.public_key,level:input.level,requester:{...expected.requester},repository:options.repository,
      repositoryId:options.repositoryId,runId:policy.run_id,attempt:policy.run_attempt};
  }
  // Only the maintained issuer receives this mode-bound transport. Credential
  // preparation precedes its final policy/member checkpoint in createGithubProvider.
  const registrationTransport=mode==='registration'?Object.freeze(Object.assign(async r=>{
    need(sourceFresh());return transport(r);
  },{prepareMutation:async argument=>{
    need(sourceFresh());const send=transport.prepareMutation?await transport.prepareMutation(argument):transport;
    return r=>{need(sourceFresh());return send(r);};
  }})):undefined;
  return Object.freeze({registrationSource,registrationTransport,authenticate:async argument=>{
    const result=await authenticated(argument);
    if(!result.ok)throw Error('host-identity:rejected');return result.identity;
  },eligibility,memberEligibility,...(options.routing==='authenticated'?{routing}:{}),observeExecution:async ({signal}={})=>{
    const result=await authenticated({...boundArgument(),signal});
    if(!isMember(mode) || !result.ok || !result.runnerId)throw Error('host-identity:runner');
    return {runnerId:result.runnerId,operatorId:api.operator.id,repository:options.repository,repositoryId:options.repositoryId,
      sourceRepository:policy.repository.toLowerCase(),sourceRepositoryId:policy.repository_id,run:{id:policy.run_id,attempt:policy.run_attempt}};
  },provider:Object.freeze({request,reconcile:async (submission,r,matches)=>{
    if(mode==='registration'||!r || !permitted({...r,method:'GET'}))return {outcome:'unknown'};
    if(!(await eligibility(r,{signal:r.signal})).ok)return {outcome:'unknown'};
    return boundary.reconcile(submission,r,matches);
  }}),provenance:testFacility?'synthetic-local-test':'github-actions-oidc'});
}
/** Inert construction; production roots are exclusively official Actions discovery/JWKS. */
export function createHostIdentityAdapters(configuration) {return compose(configuration);}
/** Explicit credential-free contract facility. Never configure this in a deployment. */
export function createHostIdentityAdaptersForTest(configuration, facility) {
  need(facility && typeof facility.transport==='function' && facility.jwks);
  return compose(configuration,facility);
}

export {githubEndpointPermission} from './provider.mjs';
