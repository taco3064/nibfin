export const skillRoles = Object.freeze({
  shape: 'shape', 'shape-validator': 'shape', 'shape-diagnosis': 'shape',
  'shaper-review': 'shape', deliver: 'deliver', accept: 'accept', 'deployment-diagnosis': 'accept',
  'rescue-diagnosis': 'rescue',
});
export function skillIdentity(stage) {
  if (!Object.hasOwn(skillRoles, stage)) throw new Error('Unknown Agent execution role');
  return skillRoles[stage];
}
export function validateSkillPolicy(policy) {
  const validate = (map, source) => {
    if (map === undefined) return;
    if (!map || Array.isArray(map) || typeof map !== 'object') throw new Error(`Invalid skills map: ${source}`);
    for (const [identity, config] of Object.entries(map)) {
      if (!['shape','deliver','accept'].includes(identity)) throw new Error(`Unknown Skill identity ${identity} in ${source}; execution roles are not Skill types`);
      if (!config || Array.isArray(config) || typeof config !== 'object' || !['default','extend','override'].includes(config.mode)) throw new Error(`Invalid Skill mode: ${source}.${identity}`);
      const fields = config.mode === 'default' ? ['mode'] : ['mode','path','hash'];
      if (Object.keys(config).some(key => !fields.includes(key))) throw new Error(`Unsupported Skill configuration field: ${source}.${identity}`);
      if (config.mode !== 'default' && (typeof config.path !== 'string' || !config.path.trim() || !/^[a-f0-9]{64}$/.test(config.hash || ''))) throw new Error(`Skill instructions require a path and approved content hash: ${source}.${identity}`);
    }
  };
  validate(policy.skills, 'policy.skills');
  for (const [repository, config] of Object.entries(policy.repositories || {})) validate(config.skills, `repositories.${repository}.skills`);
}
export function selectSkill(policy, repository, stage) {
  validateSkillPolicy(policy);
  const identity = skillIdentity(stage);
  if (!Object.hasOwn(policy.repositories || {}, repository)) throw new Error('Skill repository is outside the approved policy');
  const local = policy.repositories[repository].skills;
  const scope = local && Object.hasOwn(local,identity) ? 'repository' : policy.skills && Object.hasOwn(policy.skills,identity) ? 'cohort' : 'builtin';
  const customization = scope === 'repository' ? local[identity] : scope === 'cohort' ? policy.skills[identity] : {mode:'default'};
  return { identity, stage, repository, scope, customization: structuredClone(customization) };
}
