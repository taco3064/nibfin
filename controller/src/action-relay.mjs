import { relayDependencyEvent } from './dependency-event.mjs';
import { digest } from './core.mjs';
import { verifyActionEvent } from './action-event.mjs';
import { Store } from './store.mjs';
import { createServer } from 'node:http';
import {eventIssueReference} from './action-display.mjs';

export function createActionRelayServer(resolveContext, { dependencyOnly = false,rescueCompletion } = {}) {
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (dependencyOnly && request.url !== '/dependency-event') { response.writeHead(404).end('{}'); return; }
    if (request.method !== 'POST' || !['/event', '/dependency-event',...(rescueCompletion?['/rescue-completion']:[])].includes(request.url)) { response.writeHead(404).end('{}'); return; }
    if (active >= 8) { response.writeHead(429).end('{}'); return; }
    active++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > (request.url !== '/event' ? 256 * 1024 : 8192)) { response.writeHead(413).end('{}'); request.destroy(); return; }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if(request.url==='/rescue-completion'){
        const result=await rescueCompletion(bytes,request.headers);
        response.writeHead(202).end(JSON.stringify(result));return;
      }
      const envelope = JSON.parse(bytes.toString('utf8'));
      const dependency = request.url === '/dependency-event';
      const context = await resolveContext(dependency ? envelope?.repository?.full_name : envelope?.payload?.repository);
      if (!context) throw new Error('Repository not enrolled');
      const result = dependency ? await relayDependencyEvent(context, bytes, request.headers) : await relayActionEvent(context, envelope);
      response.writeHead(result.status === 'WAITING' ? 409 : 202).end(JSON.stringify(result));
    } catch (error) {
      const code = ['ACTION_EVENT_SIGNER_PENDING','ACTION_EVENT_INVALID'].includes(error.code) ? error.code : 'ACTION_RELAY_REJECTED';
      console.error(JSON.stringify({ kind: 'action-event-relay-result', at: new Date().toISOString(), code,
        httpStatus: [401, 403].includes(error.status) ? error.status : undefined,
        reason: code === 'ACTION_RELAY_REJECTED' ? 'Relay verification or dispatch failed; no automatic write retry' : error.message }));
      // This code is thrown only before any dispatch intent or write exists.
      // The caller may retry this response, but never an uncertain POST outcome.
      if (code === 'ACTION_EVENT_SIGNER_PENDING') {
        response.writeHead(425, { 'Retry-After': '5' }).end('{"status":"WAITING","code":"ACTION_EVENT_SIGNER_PENDING"}'); return;
      }
      // Never expose credentials, private grant paths or provider response data.
      // Preserve authentication/access status for the public Action's log, but
      // never forward provider bodies, credentials, or private endpoint paths.
      response.writeHead([401, 403].includes(error.status) ? error.status : 400).end('{"status":"REJECTED"}');
    } finally { active--; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 24;
  return server;
}

// Event transport only. GitHub credentials stay on the private host. The
// receiving Actions run independently verifies authority and chooses work.
export async function relayActionEvent({ github, entry, policy, execution, stateDirectory,resolveIssueReferences }, envelope) {
  const receivedAt = Date.now();
  const verify = () => verifyActionEvent(github, entry, envelope, policy, receivedAt);
  const p = await (github.freshReadObservation ? github.freshReadObservation(verify) : verify());
  if (!(['taco3064/kairo','taco3064/nibfin'].includes(execution.repository)) || execution.workflowPath !== (execution.repository==='taco3064/nibfin'?'.github/workflows/nibfin-controller.yml':'.github/workflows/action-stage.yml') || execution.ref !== 'main')
    throw new Error('Relay target must be the fixed private Actions entrypoint');
  const issueRef=await eventIssueReference(github,p,resolveIssueReferences);
  const id = digest({ repositoryId: p.repositoryId, runId: p.runId, attempt: p.runAttempt });
  const store = new Store(stateDirectory, `event-relay:${id}`);
  return store.lease(async () => {
    let state = await store.read();
    if (state.attempted) return { status: state.accepted ? 'DUPLICATE' : 'WAITING', code: state.accepted ? 'ALREADY_DISPATCHED' : 'DISPATCH_OUTCOME_UNKNOWN', id };
    // Record successful authentication while the short-lived notification is
    // fresh. Queue latency cannot undo reception, nor can it create authority.
    state = await store.transaction(state.revision, s => ({ ...s, attempted: true,
      envelopeHash: digest(envelope), attemptedAt: new Date().toISOString(),
      reception: {schemaVersion:1,receivedAt,bindingHash:digest(entry.binding),policyHash:digest(policy)},
      verifiedEnvelope: structuredClone(envelope) }));
    console.error(JSON.stringify({kind:'action-event-received',id,repository:p.repository,sourceRunId:p.runId,receivedAt}));
    // An uncertain write is never automatically retried, even after restart.
    await github.api('/repos/'+execution.repository+'/actions/workflows/'+execution.workflowPath.split('/').at(-1)+'/dispatches', 'POST', {
      ref: 'main', inputs: { event_envelope: JSON.stringify(envelope),issue_ref:issueRef },
    });
    await store.transaction(state.revision, s => ({ ...s, accepted: true }));
    return { status: 'DISPATCH_ACCEPTED', id };
  });
}
