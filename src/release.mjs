import {workflowFiles} from './workflow-install.mjs';
import {inspectPackageArchive} from './archive.mjs';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const releaseHash = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = reason => { throw Error('release:' + reason); };
export function releaseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail('version');
  return value;
}
export function releaseComponents(read = path => readFileSync(new URL('../' + path, import.meta.url))) {
  const pkg = JSON.parse(read('package.json'));
  releaseVersion(pkg.version);
  if (pkg.name !== '@nibfin/core') fail('package');
  const paths = [...new Set(['package.json', 'README.md', ...pkg.files])].sort();
  const files = paths.map(path => ({path, sha256:releaseHash(read(path))}));
  const component = selected => ({version:pkg.version, files:selected,
    sha256:releaseHash(JSON.stringify(selected))});
  return {core:component(files), skills:component(files.filter(f => f.path.startsWith('skills/') || f.path === 'instructions/scope.md')),
    workflow:component(files.filter(f => workflowFiles.includes(f.path))),
    action:{version:'unknown',content:'unknown',status:'unreleased'}, cli:{version:'unknown',content:'unknown',status:'unreleased'}};
}
function componentsValid(components) {
  if (!components || !components.core || !components.skills || !components.workflow) fail('components');
  for (const name of ['core','skills','workflow']) {
    const c = components[name]; releaseVersion(c.version);
    if (c.version !== components.core.version || !Array.isArray(c.files) || !c.files.length
      || c.sha256 !== releaseHash(JSON.stringify(c.files))) fail('component-identity');
    const seen = new Set();
    for (const f of c.files) {
      if (!hash(f.sha256) || typeof f.path !== 'string' || !/^[\w./-]+$/.test(f.path)
        || f.path.startsWith('/') || f.path.split('/').some(p => p === '..' || p === '') || seen.has(f.path)) fail('component-file');
      seen.add(f.path);
      if (name !== 'core' && !components.core.files.some(x => x.path === f.path && x.sha256 === f.sha256)) fail('component-mapping');
    }
  }
  for (const name of ['action','cli']) {
    if (JSON.stringify(components[name]) !== JSON.stringify({version:'unknown',content:'unknown',status:'unreleased'})) fail('upstream-mapping');
  }
}
export function validateReleaseCompatibility(metadata, components) {
  componentsValid(components);
  if (metadata?.format !== 1 || JSON.stringify(metadata.components) !== JSON.stringify(components)
      || !Array.isArray(metadata.entries) || !metadata.entries.length) fail('compatibility-format');
  const ids = new Set();
  for (const e of metadata.entries) {
    if (!e || typeof e.id !== 'string' || ids.has(e.id)) fail('entry-id'); ids.add(e.id);
    for (const key of ['agent','agentVersion','hostOS','hostArch','guestOS','guestArch','authentication','isolation',
      'ownership','visibility','registration','automaticRegistration','capability','limitations']) {
      if (typeof e[key] !== 'string' || !e[key]) fail('entry-' + key);
    }
    if (!['personal','organization','any'].includes(e.ownership) || !['repository','organization','unknown'].includes(e.registration)
        || !['enabled','disabled','unknown'].includes(e.automaticRegistration)
        || !['public','private'].includes(e.visibility) || !['Supported','Unverified','Unsupported'].includes(e.status)
        || !Array.isArray(e.evidence)) fail('entry-dimensions');
    if (e.visibility === 'private' && e.status !== 'Unsupported') fail('private');
    for (const proof of e.evidence) {
      if (!['source-contract','local-install','cli-execution','provider-execution','product-e2e','scope-exclusion'].includes(proof.type)
          || !hash(proof.sha256) || typeof proof.reference !== 'string' || !proof.reference
          || proof.capability !== e.capability || proof.configuration !== releaseHash(JSON.stringify(configuration(e)))) fail('evidence');
    }
    if (e.status === 'Supported') {
      const required = {'source-contract':'source-contract','local-install':'local-install','cli-lifecycle':'cli-execution',
        'agent-execution':'provider-execution','product-delivery':'product-e2e'}[e.capability];
      if (!required || !e.evidence.some(p => p.type === required)) fail('affirmative-evidence');
      if (['cli-lifecycle','agent-execution','product-delivery'].includes(e.capability)
          && ['agentVersion','hostOS','hostArch','guestOS','guestArch','authentication','isolation','registration','automaticRegistration']
            .some(k => e[k] === 'unknown')) fail('unmeasured-support');
    }
  }
  return metadata;
}
export function configuration(entry) {
  return Object.fromEntries(['agent','agentVersion','hostOS','hostArch','guestOS','guestArch','authentication','isolation',
    'ownership','visibility','registration','automaticRegistration','capability'].map(k => [k,entry[k]]));
}
export function verifyRelease({manifest, compatibility, compatibilityBytes, archive, expectedVersion, expectedSource, requiredCapabilities = [], read = path => readFileSync(new URL('../' + path, import.meta.url))}) {
  if (manifest?.format !== 1 || manifest.package !== '@nibfin/core') fail('manifest-format');
  releaseVersion(expectedVersion);
  if (manifest.version !== expectedVersion || manifest.version !== manifest.components?.core?.version) fail('version-mismatch');
  const s = manifest.source;
  if (!s || !['candidate','merged'].includes(s.kind) || !commit(s.base) || !hash(s.contentSha256)
    || !Array.isArray(s.inputs) || s.contentSha256 !== releaseHash(JSON.stringify(s.inputs))
    || (s.kind === 'merged' ? !commit(s.commit) : s.commit !== null)) fail('source');
  if (!expectedSource || JSON.stringify(s) !== JSON.stringify(expectedSource)) fail('source-pin');
  if (manifest.archive?.name !== 'nibfin-core.tgz' || manifest.archive.sha256 !== releaseHash(archive)) fail('archive-digest');
  if (!compatibilityBytes || manifest.compatibility?.name !== 'compatibility.json'
      || manifest.compatibility.sha256 !== releaseHash(compatibilityBytes)
      || JSON.stringify(JSON.parse(compatibilityBytes)) !== JSON.stringify(compatibility)) fail('compatibility-digest');
  validateReleaseCompatibility(compatibility,manifest.components);
  if (JSON.stringify(releaseComponents(read)) !== JSON.stringify(manifest.components)) fail('installed-content');
  const files=inspectPackageArchive(archive,manifest.components.core.files.map(f=>f.path));
  for(const f of manifest.components.core.files) {
    if(!files.has(f.path) || releaseHash(files.get(f.path))!==f.sha256
      || !s.inputs.some(input=>input.path===f.path && input.sha256===f.sha256)) fail('archive-component');
  }
  for (const requested of requiredCapabilities) {
    if (!requested || !compatibility.entries.some(e => e.status === 'Supported' && e.capability === requested.capability
      && JSON.stringify(configuration(e)) === JSON.stringify(requested.configuration))) fail('required-capability');
  }
  return manifest;
}
