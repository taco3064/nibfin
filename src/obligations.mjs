import {validateCandidateInventory} from './candidate-contract.mjs';
import {parseRequirementsDocument} from './requirements-document.mjs';
import {lstatSync} from 'node:fs';
import {resolve, join, parse} from 'node:path';

export const hookEvents = Object.freeze(['pre-commit', 'prepare-commit-msg', 'commit-msg']);
export const hookConfigurationAreas = Object.freeze(['effective-git', 'hook-directories', 'repository-setup', 'package-lifecycle', 'husky', 'workspaces']);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const diagnostic = (code, path, reason) => ({code, path, reason});
const result = (diagnostics, extra = {}) => ({ok: diagnostics.length === 0, diagnostics, ...extra});

export function safeObligationPath(path) {
  return typeof path === 'string' && path.length > 0 && !/^[A-Za-z]:/.test(path)
    && !/[\\\x00-\x1f\x7f]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function inventoryDiagnostics(inventory) {
  const errors = [];
  try {validateCandidateInventory(inventory);} catch {errors.push(diagnostic('schema', '', 'Invalid candidate obligation contract'));}
  if (!exact(inventory, ['artifacts', 'hooks'])) return [diagnostic('schema', '', 'Expected exactly artifacts and hooks')];
  for (const kind of ['artifacts', 'hooks']) {
    if (!Array.isArray(inventory[kind])) {
      errors.push(diagnostic('schema', kind, 'Expected an array'));
      continue;
    }
    const seen = new Set();
    let previous = -1;
    for (const [index, entry] of inventory[kind].entries()) {
      const location = `${kind}[${index}]`;
      if (!exact(entry, ['path', kind === 'artifacts' ? 'purpose' : 'event'])) {
        errors.push(diagnostic('schema', location, 'Invalid entry fields'));
        continue;
      }
      if (!safeObligationPath(entry.path)) errors.push(diagnostic('path', location, 'Unsafe or noncanonical relative path'));
      if (seen.has(entry.path)) errors.push(diagnostic('duplicate', location, 'Duplicate path'));
      seen.add(entry.path);
      if (kind === 'artifacts' && !nonblank(entry.purpose)) errors.push(diagnostic('purpose', location, 'Purpose must be nonblank'));
      if (kind === 'hooks') {
        const order = hookEvents.indexOf(entry.event);
        if (order < 0) errors.push(diagnostic('event', location, 'Unsupported hook event'));
        if (order < previous) errors.push(diagnostic('order', location, 'Hook events out of order'));
        previous = order;
      }
    }
  }
  return errors;
}

/** Only unindented top-level fences qualify; outer code examples are opaque. */
export function parseCandidateObligations(body) {
  const errors = [], blocks = [], prose = [];
  if (typeof body !== 'string') return result([diagnostic('body', '', 'Expected a string')]);
  try{const document=parseRequirementsDocument(body);body=document.shape??document.scope;}
  catch{return result([diagnostic('body','','Invalid requirements document')]);}
  let fence = null, content = [];
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^${fence.char}{${fence.length},}\\s*$`).test(line)) {
        if (fence.candidate) blocks.push(content.join('\n'));
        fence = null;
      } else if (fence.candidate) content.push(line);
      continue;
    }
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening) {
      fence = {char: opening[2][0], length: opening[2].length,
        candidate: opening[1] === '' && opening[3].trim() === 'kairo-candidate'};
      content = [];
    } else prose.push(line);
  }
  if (fence?.candidate) errors.push(diagnostic('fence', '', 'Unterminated candidate inventory'));
  if (blocks.length !== 1) errors.push(diagnostic('cardinality', '', 'Expected exactly one executable inventory'));
  if (errors.length) return result(errors);
  let inventory;
  try { inventory = JSON.parse(blocks[0]); }
  catch { return result([diagnostic('json', '', 'Malformed inventory JSON')]); }
  errors.push(...inventoryDiagnostics(inventory));
  const explanations = {};
  for (const kind of ['artifacts', 'hooks']) {
    const matches = prose.filter(line => line.startsWith(`Candidate ${kind} applicability:`));
    if (matches.length === 0) {
      const label = kind[0].toUpperCase() + kind.slice(1);
      const legacy = prose.join('\n').match(new RegExp(`\\b${label} is empty because ([^\\n]+)`));
      if (legacy) explanations[kind] = legacy[1].trim();
    }
    if (matches.length === 1) explanations[kind] = matches[0].slice(`Candidate ${kind} applicability:`.length).trim();
    if (Array.isArray(inventory?.[kind]) && inventory[kind].length === 0 && !nonblank(explanations[kind])) {
      errors.push(diagnostic('applicability', kind, `Empty ${kind} requires a distinct explanation`));
    }
  }
  return result(errors, {inventory, explanations});
}

/** Validate explicit observations, never infer configuration from shell text. */
export function validateHookObservation(observation) {
  const errors = [];
  if (!object(observation) || !Array.isArray(observation.areas) || !Array.isArray(observation.hooks)) {
    return result([diagnostic('configuration', '', 'Missing complete hook observation')]);
  }
  for (const area of hookConfigurationAreas) {
    const matches = observation.areas.filter(item => item?.area === area);
    if (matches.length !== 1 || matches[0].status !== 'resolved' || !nonblank(matches[0].evidenceReference)
        || !nonblank(matches[0].detail)) errors.push(diagnostic('configuration', area, 'Requires one resolved, evidenced observation'));
  }
  if (observation.areas.some(item => !hookConfigurationAreas.includes(item?.area))) errors.push(diagnostic('configuration', '', 'Unknown observation area'));
  const entries = [];
  for (const [index, hook] of observation.hooks.entries()) {
    if (!object(hook) || !nonblank(hook.evidenceReference) || !nonblank(hook.applicability)
        || !Array.isArray(hook.prerequisites)) {
      errors.push(diagnostic('configuration', `hooks[${index}]`, 'Missing hook provenance, applicability or prerequisites'));
      continue;
    }
    entries.push({path: hook.path, event: hook.event});
    for (const prerequisite of hook.prerequisites) {
      if (!object(prerequisite) || !nonblank(prerequisite.name) || !nonblank(prerequisite.evidenceReference)
          || prerequisite.status !== 'available-offline-credential-free') {
        errors.push(diagnostic('prerequisite', hook.path, `Unsupported/unresolved prerequisite: ${nonblank(prerequisite?.name) ? prerequisite.name : 'unspecified'}`));
      }
    }
  }
  errors.push(...inventoryDiagnostics({artifacts: [], hooks: entries}));
  return result(errors, {hooks: entries});
}

export function reconcileCandidateObligations(parsed, {requiredArtifacts, scopeEvidenceReference, hookObservation} = {}) {
  const errors = [...(parsed?.diagnostics ?? [diagnostic('inventory', '', 'Missing parser result')])];
  if (!parsed?.ok) return result(errors.length ? errors : [diagnostic('inventory', '', 'Failed parser result')]);
  const validation = inventoryDiagnostics(parsed.inventory);
  errors.push(...validation);
  if (validation.length) return result(errors);
  if (!nonblank(scopeEvidenceReference) || !Array.isArray(requiredArtifacts)
      || requiredArtifacts.some(item => !safeObligationPath(item?.path) || !nonblank(item?.purpose) || !nonblank(item?.evidenceReference))
      || new Set(requiredArtifacts?.map(item => item.path)).size !== requiredArtifacts?.length) {
    errors.push(diagnostic('scope', '', 'Complete evidenced Scope artifact requirements are mandatory'));
  } else {
    for (const required of requiredArtifacts) {
      if (!parsed.inventory.artifacts.some(item => item.path === required.path)) errors.push(diagnostic('missing-artifact', required.path, 'Scope-required artifact omitted'));
    }
    for (const declared of parsed.inventory.artifacts) {
      if (!requiredArtifacts.some(item => item.path === declared.path)) errors.push(diagnostic('artifact-applicability', declared.path, 'Declaration requires independent Scope applicability evidence'));
    }
  }
  const observed = validateHookObservation(hookObservation);
  errors.push(...observed.diagnostics);
  if (observed.ok && (parsed.inventory.hooks.length !== observed.hooks.length
      || parsed.inventory.hooks.some((hook, index) => hook.path !== observed.hooks[index]?.path || hook.event !== observed.hooks[index]?.event))) {
    errors.push(diagnostic('hook-correspondence', 'hooks', 'Inventory must exactly match configured source/event order'));
  }
  return result(errors);
}

/** Candidate-time only. No Git tracking/ignore queries, process or hook execution. */
export function validateCandidateFiles(inventory, {root, permittedPaths} = {}) {
  const errors = inventoryDiagnostics(inventory);
  if (errors.length) return result(errors);
  if (typeof root !== 'string' || !Array.isArray(permittedPaths) || !permittedPaths.length
      || permittedPaths.some(path => !safeObligationPath(path))) return result([diagnostic('boundary', '', 'Explicit root and permitted paths required')]);
  const absoluteRoot = resolve(root);
  // Check even the root's ancestors without following any symlink.
  const checkComponents = target => {
    let current = parse(target).root;
    for (const part of target.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Symlink component');
    }
    return lstatSync(target);
  };
  for (const entry of [...inventory.artifacts, ...inventory.hooks]) {
    if (!permittedPaths.some(path => entry.path === path || entry.path.startsWith(path + '/'))) {
      errors.push(diagnostic('boundary', entry.path, 'Outside permitted Issue paths'));
      continue;
    }
    try {
      const stat = checkComponents(join(absoluteRoot, entry.path));
      if (!stat.isFile()) throw new Error('Required target is not a regular file');
    } catch (error) {
      errors.push(diagnostic('file', entry.path, error.code === 'ENOENT' ? 'Missing mandatory file' : 'Unsafe or unreadable required file'));
    }
  }
  return result(errors);
}
