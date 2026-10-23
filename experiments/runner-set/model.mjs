// Research model only: normalized synthetic observations, never a provider adapter.
export function inspect(input) {
  const { listing, order, selector } = input;
  const unknown = reason => ({ status: 'unknown', reason, member: null, recipients: [], online: [] });
  if (!listing || listing.http !== 200 || listing.complete !== true || listing.fresh !== true ||
      !Array.isArray(listing.pages) || listing.pages.length === 0 || !Number.isSafeInteger(listing.total)) return unknown('visibility');
  if (listing.pages.some(p => !Array.isArray(p))) return unknown('malformed');
  const runners = listing.pages.flat();
  if (runners.length !== listing.total || new Set(runners.map(r => r?.id)).size !== runners.length) return unknown('pagination');
  if (runners.some(r => !r || !Number.isSafeInteger(r.id) || !Array.isArray(r.labels) ||
      r.labels.some(l => typeof l !== 'string') || typeof r.os !== 'string' ||
      !Array.isArray(r.repositories) ||
      Array.from(r.repositories).some(id => !Number.isSafeInteger(id) || id <= 0) ||
      !Number.isSafeInteger(r.group) ||
      !['online', 'offline'].includes(r.status) || typeof r.busy !== 'boolean')) return unknown('malformed');
  for (const member of order) {
    const recipients = runners.filter(r => selector.labels.every(l => r.labels.includes(l)) &&
      r.labels.includes(`member-${member}`) && r.os === selector.os && r.group === selector.group &&
      r.repositories.includes(selector.repository));
    const ids = recipients.map(r => r.id);
    // Availability is deliberately absent from the trust predicate.
    if (recipients.some(r => r.binding !== r.id || r.member !== member || r.authorized !== true ||
        r.isolated !== true || !['write', 'maintain', 'admin'].includes(r.permission))) {
      return { status: 'blocked', reason: 'untrusted-recipient', member, recipients: ids, online: [] };
    }
    const online = recipients.filter(r => r.status === 'online').map(r => r.id);
    if (online.length) return { status: 'candidate', reason: 'snapshot-only', member, recipients: ids, online };
  }
  return { status: 'waiting', reason: 'no-eligible-online', member: null, recipients: [], online: [] };
}

export function receiptTrace(input, protection, enforcement, bypass) {
  const state = structuredClone(input.initial);
  const inspected = inspect(state);
  const events = [{ event: 'inspection', observation: inspected }];
  if (inspected.status !== 'candidate') throw new Error('Trace requires a clean initial snapshot.');
  let stopped = false;
  for (const change of input.changes) {
    // Hypothetical constraint, not an installed GitHub lock or supported API.
    if (protection === 'closed-range' && enforcement && !bypass) {
      stopped = true;
      events.push({ event: change.phase, mutation: change.kind, outcome: 'denied-by-assumption' });
      continue;
    }
    if (change.kind === 'register') state.listing.pages[0].push(structuredClone(change.runner));
    else Object.assign(state.listing.pages.flat().find(r => r.id === change.id), change.patch);
    state.listing.total = state.listing.pages.flat().length;
    events.push({ event: change.phase, mutation: change.kind, outcome: 'applied' });
  }
  const current = inspect(state);
  const receiver = state.listing.pages.flat().find(r => r.id === input.receiver);
  const matches = receiver && state.selector.labels.every(l => receiver.labels.includes(l)) &&
    receiver.labels.includes(`member-${inspected.member}`) && receiver.os === state.selector.os &&
    receiver.group === state.selector.group && receiver.repositories.includes(state.selector.repository);
  const trusted = receiver && receiver.binding === receiver.id && receiver.member === inspected.member &&
    receiver.authorized === true && receiver.isolated === true && ['write', 'maintain', 'admin'].includes(receiver.permission);
  // Unknown enforcement fails closed BEFORE dispatch, even if the synthetic receiver is trusted.
  const dispatched = protection !== 'closed-range' || enforcement === true;
  const exposed = dispatched && Boolean(matches) && !trusted;
  const receiptRunner = dispatched ? (matches ? receiver.id : current.online[0] ?? null) : null;
  events.push({ event: !dispatched ? 'dispatch-denied' : receiptRunner === null ? 'queued' : 'receipt',
    runner: receiptRunner, marker: exposed ? 'HARMLESS-MODEL-DATA' : null });
  if (protection === 'post-start') events.push({ event: 'first-step-check', outcome: current.status, tooLate: exposed });
  return { exposed, earliestExposure: exposed ? 'job-receipt-before-first-step' : null, dispatched, stopped, events };
}
