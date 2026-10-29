import { readFile, readdir, lstat, mkdir, open } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, digest, binding } from './core.mjs';
import { verifyGrant, verifyCoreUpgrade, coreDigest, outside } from './authority.mjs';
import { Store } from './store.mjs';
import { unitId, issueLeaseId, projectUnit } from './dynamic.mjs';
import { runtimeConfigurationHash } from './runtime.mjs';
import { verifyRequirementRevision, attachRequirementRevision, attachRevisionCoreRepair, revisionStore } from './requirement-revision.mjs';
import { verifyAssigneeRevision, assigneeRevisionStore } from './assignee-revision.mjs';
import { readRevisionIssue } from './requirement-revision-host.mjs';
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonical(a) === canonical(b);
async function sync(path) { const f = await open(path, 'r'); try { await f.sync(); } finally { await f.close(); } }

// Read-only capture usable before signing/installing. The second read closes
// body/state races; neither a missing Projects permission nor partial pages pass.
export async function readAssigneeRevisionIssue(github, subject) {
  const o = await readRevisionIssue(github, subject), r = await github.issue({ ...subject, id: subject.issueId });
  const metadata = { title: r.title, state: r.state, labels: r.labels.map(x => x.name).sort(),
    assignees: r.assignees.map(x => String(x.id)).sort(), milestone: r.milestone ? String(r.milestone.id) : null,
    projects: o.metadata.projects };
  need(r.node_id === o.issueId && digest(r.body) === o.bodyHash && same(metadata, o.metadata) &&
    Number.isSafeInteger(r.id) && r.id > 0, 'ASSIGNEE_OBSERVATION_CHANGED');
  return { ...o, databaseId: r.id, stateReason: r.state_reason || null };
}
async function inventory(root, paths) {
  const files = new Map();
  async function visit(path) {
    need(!outside(root, path), 'ASSIGNEE_ARCHIVE_PATH_INVALID');
    let stat; try { stat = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    need(!stat.isSymbolicLink(), 'ASSIGNEE_ARCHIVE_SYMLINK');
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    else { need(stat.isFile(), 'ASSIGNEE_ARCHIVE_SPECIAL_FILE'); const b = await readFile(path);
      files.set(relative(root, path), { path: relative(root, path), bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') }); }
  }
  for (const p of paths) await visit(p); return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
async function defaultContainers(agent) {
  const { command } = await import('./process.mjs');
  const {dockerCommand}=await import('./docker-security.mjs');
  const { stdout } = await dockerCommand(agent,command)('docker', ['ps', '--format', '{{.Names}}']);
  return stdout.split('\n').filter(x => /^kairo-[a-f0-9]{8}-/i.test(x));
}
export async function createAssigneeRevisionHost(config, root, github, signed, { containers = defaultContainers } = {}) {
  need(process.platform === 'linux', 'ASSIGNEE_OPERATOR_LINUX_REQUIRED');
  need(outside(root, config.stateDirectory) && outside(root, config.publicKeyPath) &&
    outside(config.stateDirectory, config.agent.authDirectory), 'ASSIGNEE_TRUSTED_PATHS_INVALID');
  const publicKey = await readFile(config.publicKeyPath, 'utf8'), originalBundle = await github.grant(config.grantSource);
  const grant = verifyGrant(originalBundle, publicKey);
  const prior = verifyRequirementRevision(originalBundle.requirementRevision, grant, publicKey); attachRequirementRevision(grant, prior);
  const record = verifyAssigneeRevision(signed, grant, publicKey, prior.revisionHash);
  const identify = s => grant.manifest.issues.find(i => i.id === s.issueId);
  const oldStore = s => new Store(config.stateDirectory, unitId(grant, identify(s)));
  const archiveRoot = join(config.stateDirectory, 'assignee-requirement-archives', record.revisionHash);
  const host = { installedCoreDigest: await coreDigest(root), store: assigneeRevisionStore(config.stateDirectory, grant),
    syncJournal: async () => { await sync(host.store.directory); await sync(config.stateDirectory); },
    authorize: async () => {
      const b = await github.grant(config.grantSource), g = verifyGrant(b, publicKey);
      need(digest(b.payload) === record.parentPayloadHash && digest(b.requirementRevision) === record.priorRequirementRevisionHash &&
        digest(b.assigneeOrderRevision) === record.revisionHash, 'ASSIGNEE_ENROLLMENT_CHANGED');
      verifyAssigneeRevision(b.assigneeOrderRevision, g, publicKey, digest(b.requirementRevision));
      need(g.policy.stateDirectory === config.stateDirectory && g.policy.runtimeHash === runtimeConfigurationHash(config) &&
        digest(await github.text(config.proposalSource)) === g.manifest.proposalHash, 'ASSIGNEE_PARENT_FREEZE_CHANGED');
      const actual = await coreDigest(root); need(actual === record.requiredCoreDigest, 'ASSIGNEE_CORE_NOT_INSTALLED');
      const upgrades = [b.coreUpgrade, ...(b.coreUpgrades || [])].filter(x => x?.payload?.toCoreDigest === actual);
      need(upgrades.length === 1, 'ASSIGNEE_CORE_UPGRADE_AMBIGUOUS'); verifyCoreUpgrade(upgrades[0], g, actual, publicKey);
      const old = verifyRequirementRevision(b.requirementRevision, g, publicKey); attachRequirementRevision(g, old);
      const repairs = (b.revisionCoreRepairs || []).filter(x => x.payload?.toCoreDigest === actual);
      need(repairs.length === 1, 'ASSIGNEE_PRIOR_CORE_REPAIR_REQUIRED');
      const repair = attachRevisionCoreRepair(repairs[0], g, publicKey, actual), oldJournal = await revisionStore(config.stateDirectory, g).read();
      need(oldJournal.phase === 'active' && oldJournal.revisionHash === record.priorRequirementRevisionHash &&
        !oldJournal.operatorHold && oldJournal.activation?.revisionHash === old.revisionHash &&
        oldJournal.activation.archivesHash === digest(oldJournal.archives) && oldJournal.activation.operationsHash === digest(oldJournal.operations) &&
        oldJournal.runtimeRecovery && oldJournal.runtimeRecovery.recoveryPlanHash === repair.recoveryPlanHash &&
        (oldJournal.runtimeRecovery.coreDigest === actual || repair.retainedRecoveryHash === digest(oldJournal.runtimeRecovery)), 'ASSIGNEE_PRIOR_RECOVERY_CHANGED');
      const actor = await github.api('/user'); need(actor.type === 'User' && String(actor.id) === g.actorGitHubUserId, 'ASSIGNEE_OPERATOR_CHANGED');
      const outbox = await new Store(config.stateDirectory, `actions-outbox:${g.policy.actionExecution.repositoryId}`).read();
      need(!Object.values(outbox.items || {}).some(x => record.subjects.some(s => s.issueId === x.request?.issueId) && !x.finishedAt),
        'ASSIGNEE_OUTBOX_RECONCILIATION_REQUIRED');
      // The revision does not silently release any independent Owner hold.
      need(!(b.ownerExecutionHolds || []).some(h => record.subjects.some(s => s.issueId === h.payload?.issueId)), 'ASSIGNEE_OWNER_HOLD_REQUIRES_DECISION');
    },
    verifyUnaffected: async expected => {
      for (const row of expected) {
        const i = grant.manifest.issues.find(i => i.id === row.issueId), s = await new Store(config.stateDirectory, unitId(grant, i)).read();
        need(row.unitId === unitId(grant, i) && row.projectionHash === digest(projectUnit(grant, i)) && row.stateHash === digest(s), 'ASSIGNEE_UNAFFECTED_CHANGED');
      }
    },
    withSubjectLeases: async (subjects, work) => {
      const ids = subjects.flatMap(s => [issueLeaseId(identify(s)), unitId(grant, identify(s))]);
      ids.push(`repository-write:${subjects[0].repositoryId}`);
      const enter = n => n === ids.length ? work() : new Store(config.stateDirectory, ids[n]).lease(() => enter(n + 1)); return enter(0);
    },
    history: async s => {
      const active = await containers(config.agent); need(Array.isArray(active) && active.length === 0, 'ASSIGNEE_ACTIVE_AGENT_PRESENT');
      const state = await oldStore(s).read(), v = state.issues?.[s.issueId];
      return { stateHash: digest(state), pending: state.pending, candidate: !!v?.candidate, completed: !!state.completion || !!v?.completed,
        shapeHash: v?.shape?.bodyHash || null, quiescent: true, state };
    },
    archive: async (s, h) => {
      const p = projectUnit(grant, identify(s)), paths = [join(config.stateDirectory, 'workspaces', digest(p.manifest.id))];
      for (const role of ['shaper', 'deliver']) {
        const key = digest({ repository: s.repository, issue: s.issueId, scope: s.oldScopeHash, binding: binding(p.manifest, p.policy), role });
        paths.push(join(config.stateDirectory, 'role-sessions', key), new Store(config.stateDirectory, 'role-session:' + key).directory);
      }
      const scan = x => { if (Array.isArray(x)) x.forEach(scan); else if (x && typeof x === 'object') {
        if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x.executionId || ''))
          for (const folder of ['executions', 'delivery-input-snapshots']) paths.push(join(config.stateDirectory, folder, x.executionId));
        Object.values(x).forEach(scan);
      } }; scan(h.state);
      const snapshot = { issueId: s.issueId, originalBundle, scope: identify(s), state: h.state,
        files: await inventory(config.stateDirectory, paths) };
      await mkdir(archiveRoot, { recursive: true, mode: 0o700 }); const path = join(archiveRoot, s.issueId + '.json');
      try { const f = await open(path, 'wx', 0o400); try { await f.writeFile(JSON.stringify(snapshot)); await f.sync(); } finally { await f.close(); } }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      await sync(archiveRoot); await sync(dirname(archiveRoot)); await sync(config.stateDirectory);
      const actual = JSON.parse(await readFile(path, 'utf8'));
      need(same(actual, snapshot), 'ASSIGNEE_ARCHIVE_CONFLICT'); return { issueId: s.issueId, digest: digest(actual), verified: true };
    },
    verifyArchives: async archives => {
      for (const a of archives) {
        const s = record.subjects.find(s => s.issueId === a.issueId), snapshot = JSON.parse(await readFile(join(archiveRoot, a.issueId + '.json'), 'utf8'));
        need(s && digest(snapshot) === a.digest && digest(await oldStore(s).read()) === s.oldStateHash, 'ASSIGNEE_ARCHIVE_CHANGED');
        for (const row of snapshot.files) {
          const path = resolve(config.stateDirectory, row.path); need(!outside(config.stateDirectory, path), 'ASSIGNEE_ARCHIVE_PATH_INVALID');
          const stat = await lstat(path); need(stat.isFile() && !stat.isSymbolicLink(), 'ASSIGNEE_ARCHIVE_CHANGED');
          const b = await readFile(path); need(b.length === row.bytes && createHash('sha256').update(b).digest('hex') === row.sha256, 'ASSIGNEE_ARCHIVE_CHANGED');
        }
      }
    },
    observe: s => readAssigneeRevisionIssue(github, s),
    mutate: async (id, approved) => {
      need(approved === record, 'ASSIGNEE_OPERATION_DENIED');
      const a = identify(record.subjects.find(s => s.number === 28)), b = identify(record.subjects.find(s => s.number === 31));
      if (id === 'replace-31-body') await github.updateIssue(b, { body: record.subjects.find(s => s.number === 31).newScopeBody });
      else if (id === 'remove-28-blocks-31') await github.api(`/repos/${b.repository}/issues/${b.number}/dependencies/blocked_by/${record.retiredDatabaseId}`, 'DELETE');
      else if (id === 'close-28-not-planned') await github.updateIssue(a, { state: 'closed', state_reason: 'not_planned' });
      else need(false, 'ASSIGNEE_OPERATION_DENIED');
    }
  };
  return { host, record, grant };
}
