import { mkdir, readdir, lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { command } from './process.mjs';
import { digest } from './core.mjs';
import { repoPath } from './github.mjs';
import { safeCandidatePath } from './candidate-contract.mjs';
import { ghEnvironment } from './gh-cli.mjs';

export class Workspace {
  constructor(root, issue, token, run = command) {
    repoPath(issue.repository);
    this.root = resolve(root); this.issue = issue; this.run = run;
    this.work = join(this.root, 'work'); this.gitDir = join(this.root, 'repository.git');
    this.env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(this.root, 'no-hooks'), GIT_CONFIG_KEY_2: 'core.autocrlf', GIT_CONFIG_VALUE_2: 'false' };
    if (token === undefined) {
      this.env = { ...ghEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '5',
        GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential',
        GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: join(this.root, 'no-hooks'),
        GIT_CONFIG_KEY_3: 'core.autocrlf', GIT_CONFIG_VALUE_3: 'false',
        GIT_CONFIG_KEY_4: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_4: '' };
    }
  }
  async git(args, input, extraEnv = {}) {
    try {
      return (await this.run('git', [`--git-dir=${this.gitDir}`, `--work-tree=${this.work}`, ...args], { cwd: this.work, env: { ...this.env, ...extraEnv }, input })).stdout.trimEnd();
    } catch (error) {
      if (['fetch', 'push'].includes(args[0])) {
        const status = Number(/(?:HTTP|error:)\s*(401|403)\b/i.exec(error.stderr || '')?.[1]) || undefined;
        const auth = status === 401 || /authentication failed|could not read Username/i.test(error.stderr || '');
        if (auth || status) throw Object.assign(new Error(`Git ${args[0]} failed using gh login${status ? `: HTTP ${status}` : ''}; check runner user's gh authentication and repository access`),
          { code: auth ? 'GITHUB_AUTH_FAILED' : 'GIT_REMOTE_FAILED', status, exitCode: error.exitCode });
      }
      throw error;
    }
  }
  async prepare(base) {
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid base SHA');
    await mkdir(this.work, { recursive: true });
    try { await lstat(this.gitDir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.run('git', ['init', '--bare', this.gitDir], { env: this.env });
      await this.git(['remote', 'add', 'origin', `https://github.com/${this.issue.repository}.git`]);
      await this.git(['fetch', '--no-tags', 'origin', base]);
      await this.git(['read-tree', base]);
      await this.git(['checkout-index', '--all']);
    }
    // No participant .git directory is exposed to any Agent.
    await this.checkFiles();
    let previous;
    try { previous = JSON.parse(await readFile(join(this.root, 'workspace-base.json'), 'utf8')).base; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Older repair workspaces may have fetched their seed after the base.
      try { previous = JSON.parse(await readFile(join(this.root, 'repair-restoration.json'), 'utf8')).base; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      previous ||= await this.fetchedBase();
    }
    if (!/^[a-f0-9]{40}$/.test(previous || '')) throw new Error('Workspace base identity is invalid');
    if (previous !== base) {
      // A queued first delivery may start after main advances. Refresh only an
      // untouched baseline; existing candidate work must go through repair.
      const changed = await this.git(['diff', '--name-only', previous, '--']);
      const staged = await this.git(['diff', '--cached', '--name-only', previous, '--']);
      const untracked = await this.git(['ls-files', '--others', '--exclude-standard']);
      if (changed || staged || untracked) throw new Error('Workspace base advanced with local changes; explicit candidate repair required');
      await this.git(['fetch', '--no-tags', 'origin', base]);
      await this.git(['read-tree', '--reset', '-u', base]);
      await this.checkFiles();
    }
    await writeFile(join(this.root, 'workspace-base.json'), JSON.stringify({base}) + '\n', {mode:0o600});
  }
  async fetchedBase() {
    // Shape workspaces fetch once. FETCH_HEAD is controller-only Git metadata,
    // unlike an Agent-writable context file, and retains the investigated base.
    const base = await this.git(['rev-parse', 'FETCH_HEAD']);
    if (!/^[a-f0-9]{40}$/.test(base)) throw Error('Shape workspace has no verified fetched base');
    return base;
  }
  async preparedBase() {
    // Deliver repair fetches change FETCH_HEAD. Only the controller's marker
    // outside the Agent-mounted work directory records the prepared baseline.
    const path = join(this.root, 'workspace-base.json'), meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1 || meta.size > 4096) throw Error('Unsafe workspace base marker');
    const base = JSON.parse(await readFile(path, 'utf8')).base;
    if (!/^[a-f0-9]{40}$/.test(base || '')) throw Error('Invalid prepared workspace base');
    return base;
  }
  async checkFiles() {
    const walk = async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name.toLowerCase() === '.git') throw new Error('Agent workspace must not contain .git');
        if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in isolated MVP workspaces');
        if (entry.isDirectory()) await walk(join(path, entry.name));
      }
    };
    await walk(this.work);
  }
  async capture(base, allowEmpty = false, obligations) {
    await this.checkFiles();
    await this.git(['add', '--all', '--', '.']);
    const tree = await this.git(['write-tree']);
    const diff = await this.git(['diff', '--cached', '--binary', '--no-ext-diff', base, '--']);
    const paths = (await this.git(['diff', '--cached', '--name-only', '-z', base, '--'])).split('\0').filter(Boolean);
    if (paths.length === 0 && !allowEmpty) throw new Error('Delivery candidate has no changes');
    const candidate = { repository: this.issue.repository, base, tree, diffHash: digest(diff), paths };
    if (obligations) {
      candidate.obligations = obligations;
      candidate.artifacts = await this.artifactManifest(obligations.artifacts);
      candidate.hookSources = await this.artifactManifest(obligations.hooks);
    }
    return candidate;
  }
  async artifactManifest(entries) {
    const manifest = [];
    for (const entry of entries) {
      if (!safeCandidatePath(entry.path)) throw new Error('Unsafe artifact path');
      const path = join(this.work, entry.path);
      if (!(await lstat(path)).isFile()) throw new Error('Required artifact must be a regular file');
      const bytes = await readFile(path), sha256 = createHash('sha256').update(bytes).digest('hex');
      const directory = join(this.root, 'artifacts');
      await mkdir(directory, {recursive:true, mode:0o700});
      const snapshot = join(directory, sha256);
      try { await writeFile(snapshot, bytes, {flag:'wx', mode:0o400}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (createHash('sha256').update(await readFile(snapshot)).digest('hex') !== sha256) throw new Error('Artifact snapshot corrupted');
      manifest.push({...entry, size:bytes.length, sha256});
    }
    return manifest;
  }
  async snapshotCandidate(candidate) {
    if (candidate.repository !== this.issue.repository ||
        !/^[a-f0-9]{40}$/.test(candidate.base || '') || !/^[a-f0-9]{40}$/.test(candidate.tree || ''))
      throw new Error('Invalid repair source identity');
    if (digest(await this.git(['diff','--binary','--no-ext-diff',candidate.base,candidate.tree,'--'])) !== candidate.diffHash)
      throw new Error('Repair source diff differs from recorded candidate');
    for (const item of [...(candidate.artifacts || []), ...(candidate.hookSources || [])]) {
      const bytes = await readFile(join(this.root,'artifacts',item.sha256));
      if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
        throw new Error('Repair source artifact snapshot differs');
    }
    const identity = {GIT_AUTHOR_NAME:'upstream',GIT_AUTHOR_EMAIL:'nibfin@localhost',GIT_COMMITTER_NAME:'upstream',GIT_COMMITTER_EMAIL:'nibfin@localhost',GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'};
    const commit = await this.git(['commit-tree',candidate.tree,'-p',candidate.base], 'Preserved repair candidate '+digest(candidate)+'\n', identity);
    await this.git(['update-ref','refs/nibfin/repair-candidates/'+digest(candidate),commit]);
    return {candidate:structuredClone(candidate),candidateHash:digest(candidate),commit};
  }
  async snapshotRepair(base, obligations) {
    // A failed capture is not an accepted candidate. Preserve regular Git
    // source plus available declared outputs, without copying ignored tooling
    // (npm commonly leaves symlinks there) into the next isolated workspace.
    await this.git(['add', '--all', '--', '.']);
    const tree = await this.git(['write-tree']);
    const entries = (await this.git(['ls-tree', '-r', '-z', tree])).split('\0').filter(Boolean);
    for (const line of entries) {
      const tab = line.indexOf('\t'), path = line.slice(tab + 1);
      if (tab < 0 || !/^100(?:644|755) blob [a-f0-9]{40}$/.test(line.slice(0, tab)) ||
          !safeCandidatePath(path) || path.split('/').some(p => p.toLowerCase() === '.git'))
        throw new Error('Repair snapshot requires regular source files');
    }
    const available = {artifacts:[], hooks:[]}, manifests = {artifacts:[], hooks:[]}, missing = [];
    for (const kind of ['artifacts', 'hooks']) for (const entry of obligations[kind]) {
      if (!safeCandidatePath(entry.path)) throw new Error('Unsafe repair output path');
      try {
        // Never follow an ignored symlink when reading a declared output.
        let parent = this.work;
        for (const part of entry.path.split('/')) {
          parent = join(parent, part);
          if ((await lstat(parent)).isSymbolicLink()) throw new Error('Repair output contains a symlink');
        }
        manifests[kind].push(...await this.artifactManifest([entry]));
        available[kind].push(entry);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push({kind, path:entry.path});
      }
    }
    const candidate = {repository:this.issue.repository, base, tree,
      diffHash:digest(await this.git(['diff','--cached','--binary','--no-ext-diff',base,'--'])),
      paths:(await this.git(['diff','--cached','--name-only','-z',base,'--'])).split('\0').filter(Boolean),
      obligations:available, artifacts:manifests.artifacts, hookSources:manifests.hooks};
    return {...await this.snapshotCandidate(candidate), unaccepted:true, missingOutputs:missing};
  }
  async restoreRepair(source, seed, base) {
    if (seed.candidateHash !== digest(seed.candidate) || seed.candidate.repository !== this.issue.repository)
      throw new Error('Repair source binding differs');
    if ((await source.snapshotCandidate(seed.candidate)).commit !== seed.commit) throw new Error('Repair source commit differs');
    await this.prepare(base);
    const path = join(this.root,'repair-restoration.json'), binding = digest({seed,base});
    let record;
    try { record = JSON.parse(await readFile(path,'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (record) {
      if (record.binding !== binding || !['restoring','restored'].includes(record.status)) throw new Error('Different repair restoration requires explicit reconciliation');
      if(record.status==='restored')return record;
      // No Agent starts until this method finishes. With the Issue execution
      // lease held, a partial local restoration can be repeated safely.
    }
    if (!record && (await this.capture(base,true)).tree !== await this.git(['rev-parse',base+'^{tree}']))
      throw new Error('Repair target has other changes; refusing to overwrite them');
    const save = async value => {const temporary=path+'.tmp';await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,path);};
    await save({binding,status:'restoring',sourceCandidateHash:seed.candidateHash,base});
    await this.git(['fetch','--no-tags',source.gitDir,seed.commit]);
    if(await this.git(['rev-parse',seed.commit+'^{tree}'])!==seed.candidate.tree ||
       await this.git(['rev-parse',seed.commit+'^'])!==seed.candidate.base)throw new Error('Fetched repair identity differs');
    let conflicts=[];
    if (base === seed.candidate.base) await this.git(['read-tree','--reset','-u',seed.candidate.tree]);
    else {
      await this.git(['fetch','--no-tags','origin',base]);
      await this.git(['read-tree','--reset','-u',base]);
      const patch=await source.git(['diff','--binary','--no-ext-diff',seed.candidate.base,seed.candidate.tree,'--']);
      try {await this.git(['apply','--3way','--index','--binary','-'],patch+'\n');}
      catch(error){conflicts=(await this.git(['diff','--name-only','--diff-filter=U','-z'])).split('\0').filter(Boolean);if(!conflicts.length)throw error;}
    }
    for(const item of [...(seed.candidate.artifacts || []),...(seed.candidate.hookSources || [])]) {
      if(!safeCandidatePath(item.path))throw new Error('Unsafe repair artifact path');
      if(await this.git(['ls-files','--',item.path]))continue;
      const bytes=await readFile(join(source.root,'artifacts',item.sha256)),target=join(this.work,item.path);
      await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,bytes,{mode:0o600});
    }
    await this.checkFiles();
    if(base===seed.candidate.base && digest(await this.capture(base,true,seed.candidate.obligations))!==seed.candidateHash)
      throw new Error('Restored candidate identity differs');
    record={binding,status:'restored',sourceCandidateHash:seed.candidateHash,base,conflicts,restoredAt:new Date().toISOString()};
    await save(record);return record;
  }
  commitMessage(candidate) { return `Deliver #${this.issue.number}\n\nCandidate: ${digest(candidate)}\n`; }
  async hookRepository(base, candidate) {
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid hook baseline');
    const directory = join(this.root,'hook-baseline.git');
    await this.run('git',['init','--bare','--template=',directory],{env:this.env});
    // Fetch objects into a new repository, never copy controller configuration.
    await this.run('git',[`--git-dir=${directory}`,'fetch','--no-tags',this.gitDir,base],{env:this.env});
    await this.run('git',[`--git-dir=${directory}`,'update-ref','refs/heads/nibfin',base],{env:this.env});
    await this.run('git',[`--git-dir=${directory}`,'symbolic-ref','HEAD','refs/heads/nibfin'],{env:this.env});
    return {directory,base,tree:candidate.tree,paths:candidate.paths,commitMessage:this.commitMessage(candidate)};
  }
  async captureAttempt(base) {
    const candidate = await this.capture(base, true), files = [];
    const walk = async (directory, prefix = '') => {
      for (const entry of await readdir(directory, {withFileTypes:true})) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) await walk(join(directory,entry.name),path + '/');
        else if (entry.isFile()) files.push({path, hash:digest((await readFile(join(directory,entry.name))).toString('base64'))});
        else throw new Error('Unsupported attempt file');
      }
    };
    await walk(this.work);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
    return {...candidate,workspaceHash:digest(files),workspaceFiles:files};
  }
  async diff(base) { return this.git(['diff', '--cached', '--binary', '--no-ext-diff', base, '--']); }
  async provenance(base, candidateTree) {
    const tree = candidateTree || await this.git(['rev-parse', `${base}^{tree}`]);
    const entries = (await this.git(['ls-tree', '-r', '-z', '--full-tree', tree])).split('\0').filter(Boolean).map(line => {
      const tab = line.indexOf('\t');
      const [mode, type, oid] = line.slice(0, tab).split(' ');
      return { path: line.slice(tab + 1), mode, type, oid };
    });
    return { repository: this.issue.repository, origin: `https://github.com/${this.issue.repository}.git`, base, tree, entries, objectFormat: 'Git SHA-1: hash the blob header plus exact file bytes', observedBy: 'trusted-controller-git-adapter' };
  }
  async commit(candidate, timestamp) {
    const current = await this.capture(candidate.base, false, candidate.obligations);
    if (digest(current) !== digest(candidate)) throw new Error('Candidate changed after independent acceptance');
    const identity = { GIT_AUTHOR_NAME: 'upstream', GIT_AUTHOR_EMAIL: 'nibfin@localhost', GIT_COMMITTER_NAME: 'upstream', GIT_COMMITTER_EMAIL: 'nibfin@localhost', GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp };
    const commit = await this.git(['commit-tree', candidate.tree, '-p', candidate.base], this.commitMessage(candidate), identity);
    if (await this.git(['rev-parse', `${commit}^{tree}`]) !== candidate.tree) throw new Error('Committed tree mismatch');
    return commit;
  }
  async mergeCommit(candidate, head, timestamp) {
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid reviewed head');
    if (await this.git(['rev-parse', head + '^{tree}']) !== candidate.tree || await this.git(['rev-parse', head + '^']) !== candidate.base) throw new Error('Reviewed head does not match accepted tree and base');
    const identity = { GIT_AUTHOR_NAME: 'upstream', GIT_AUTHOR_EMAIL: 'nibfin@localhost', GIT_COMMITTER_NAME: 'upstream', GIT_COMMITTER_EMAIL: 'nibfin@localhost', GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp };
    return this.git(['commit-tree', candidate.tree, '-p', candidate.base, '-p', head], 'Merge reviewed upstream candidate\n', identity);
  }
  async advanceBase(commit, branch, expectedBase) {
    await this.git(['check-ref-format', 'refs/heads/' + branch]);
    if (!/^[a-f0-9]{40}$/.test(expectedBase)) throw new Error('Invalid expected base');
    // Explicit lease is a server-side compare-and-swap. The commit remains a
    // descendant of expectedBase; never overwrite an unrelated branch update.
    if (await this.git(['rev-parse', commit + '^1']) !== expectedBase) throw new Error('Merge commit has an unexpected first parent');
    const remote = await this.git(['ls-remote', 'origin', 'refs/heads/' + branch]);
    if (remote.split(/\s/)[0] === commit) return;
    try { await this.git(['push', '--porcelain', '--force-with-lease=refs/heads/' + branch + ':' + expectedBase, 'origin', commit + ':refs/heads/' + branch]); }
    catch (error) {
      if ((error.stdout || '').includes('[rejected] (stale info)')) throw Object.assign(new Error('Base advanced before atomic merge'), {code:'BASE_LEASE_REJECTED'});
      throw error;
    }
  }
  async push(commit, branch) {
    await this.git(['check-ref-format', `refs/heads/${branch}`]);
    const remote = await this.git(['ls-remote', 'origin', `refs/heads/${branch}`]);
    if (remote) {
      if (remote.split(/\s/)[0] !== commit) throw new Error('Controlled branch already contains an unexpected head');
      return;
    }
    await this.git(['push', 'origin', `${commit}:refs/heads/${branch}`]);
  }
}
