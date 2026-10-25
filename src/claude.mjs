import {fileURLToPath} from 'node:url';
import {createLinuxBackend, linuxCodexProfile} from './codex.mjs';

const {codex, ...transportProfile}=linuxCodexProfile;
export const linuxClaudeProfile = Object.freeze({...transportProfile,
  id:'linux-amd64-claude-v1', claude:'2.1.285 (Claude Code)',
  authentication:'anthropic-api-key-file'});
const diagnostics = Object.freeze(['cli-unavailable','unsupported-version','unsupported-features',
  'unsafe-configuration','login-rejected','provider-failure','invalid-result','ready']);
export function createLinuxClaudeBackend(config) {
  return createLinuxBackend(config, Object.freeze({agent:'claude',identity:linuxClaudeProfile,
    entry:fileURLToPath(new URL('./claude-entry.mjs',import.meta.url)),
    version:linuxClaudeProfile.claude, diagnostics,
    authName:'anthropic-api-key.json', authTarget:'/login.json',
    forbidden:['.claude','.mcp.json','CLAUDE.md','CLAUDE.local.md'],
    login(bytes) {
      const v=JSON.parse(bytes);
      if (Object.keys(v).sort().join(',') !== 'api_key,auth_mode' || v.auth_mode !== 'anthropic-api-key'
          || typeof v.api_key !== 'string' || !v.api_key.trim() || /[\x00-\x20]/.test(v.api_key))
        throw Error('claude:unsupported-login');
      return Object.freeze([v.api_key]);
    }}));
}
