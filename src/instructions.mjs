import {readFileSync} from 'node:fs';
import {bodyDigest} from './grants.mjs';
import {protectedSkills, skillForRole} from './evidence.mjs';

const fail = reason => { throw new TypeError(`instructions:${reason}`); };
const builtins = Object.fromEntries(protectedSkills.map(skill => [skill,
  readFileSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8')]));
export const instructionSeparator = '\n\n';
const object = v => v !== null && Object.getPrototypeOf(v) === Object.prototype;
function fields(v, names) {
  if (!object(v) || Object.keys(v).sort().join(' ') !== names.split(' ').sort().join(' ')) fail('fields');
}
function level(v) {
  if (!object(v) || Object.keys(v).some(k => !protectedSkills.includes(k))) fail('configuration');
}
/** Explicit inputs only. Approval expectations must come from a trusted caller. */
export function selectInstructions({skill, role, repository = {}, shared = {}, approvals = {}}) {
  if (!protectedSkills.includes(skill)) fail('skill');
  if (skillForRole(role) !== skill) fail('role');
  level(repository); level(shared);
  const source = Object.hasOwn(repository, skill) ? 'repository'
    : Object.hasOwn(shared, skill) ? 'shared' : 'builtin';
  const config = source === 'builtin' ? {mode:'default'} : {repository, shared}[source][skill];
  if (!object(config) || !['default', 'extend', 'override'].includes(config.mode)) fail('mode');
  const {mode} = config;
  let custom = null, inputIdentity = null;
  if (mode === 'default') fields(config, 'mode');
  else {
    fields(config, 'mode content');
    if (typeof config.content !== 'string' || !config.content.trim()
        || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(config.content)) fail('content');
    custom = config.content;
    inputIdentity = bodyDigest(custom);
  }
  // Bind the entire selected configuration, including default resets and mode.
  const configurationIdentity = bodyDigest(JSON.stringify(config.mode === 'default'
    ? {mode} : {mode, content:custom}));
  if (source !== 'builtin') {
    const expected = approvals?.[source]?.[skill];
    fields(expected, 'configurationIdentity');
    if (expected.configurationIdentity !== configurationIdentity) fail('approval');
  }
  const builtin = builtins[skill];
  const content = mode === 'default' ? builtin : mode === 'override' ? custom
    : builtin + instructionSeparator + custom;
  return Object.freeze({skill, role, source, mode, configurationIdentity, inputIdentity,
    builtinIdentity:bodyDigest(builtin), identity:bodyDigest(content), content});
}
