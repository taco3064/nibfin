import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './core.mjs';

// One trusted local host, one store per cohort across all owning repositories.
// No automatic stale-lock stealing: an operator must establish the old process
// is dead before removing its lock. This avoids split-brain side effects.
export class Store {
  constructor(root, cohortId) {
    this.directory = join(resolve(root), digest(cohortId));
  }
  async read() {
    try {
      const record = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      if (record.hash !== digest(record.payload)) throw new Error('State integrity check failed');
      return record.payload;
    } catch (error) {
      if (error.code === 'ENOENT') return { revision: 0, events: [], pending: null };
      throw error;
    }
  }
  async transaction(expectedRevision, update) {
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, 'lock');
    const lock = await open(lockPath, 'wx');
    let temp;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await lock.sync();
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new Error('State revision conflict');
      // Failed validation/I/O must not advance the caller's in-memory revision.
      const next = structuredClone(await update(structuredClone(current)));
      next.revision = current.revision + 1;
      const record = { payload: next, hash: digest(next) };
      temp = join(this.directory, `${randomUUID()}.tmp`);
      const handle = await open(temp, 'wx');
      try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, join(this.directory, 'state.json'));
      return next;
    } finally {
      if (temp) await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await lock.close();
      await unlink(lockPath);
    }
  }
  async recordDecision(expectedRevision, decision) {
    return this.transaction(expectedRevision, state => {
      if (state.events.some(event => event.decisionId === decision.decisionId)) throw new Error('Duplicate decision');
      state.events.push(decision);
      return state;
    });
  }
  async metadataLease(work) {
    for (let attempt=0;;attempt++) {
      let entered=false;
      try { return await this.lease(()=>{entered=true;return work();}); }
      catch(error) { if(entered||error.code!=='EEXIST'||attempt>=100)throw error; await delay(25+Math.floor(Math.random()*25)); }
    }
  }
  async lease(work, {waitMs = 0} = {}) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw Error('Invalid lease wait bound');
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, 'execution.lock');
    const deadline = Date.now() + waitMs;
    let handle;
    for (;;) {
      try { handle = await open(path, 'wx'); break; }
      catch (error) {
        if (error.code === 'EEXIST' && waitMs && Date.now() >= deadline) throw Object.assign(new Error('Timed out waiting for execution lease'),{code:'LEASE_WAIT_TIMEOUT',cause:error});
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
        await delay(Math.min(100,deadline-Date.now()));
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.sync();
      return await work();
    } finally { await handle.close(); await unlink(path); }
  }
}
