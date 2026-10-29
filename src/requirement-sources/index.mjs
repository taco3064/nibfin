import {githubIssueRequirementSource} from './github-issue.mjs';

// Explicit maintained catalog, never dynamically imported from requirement text.
// Add a separately maintained adapter here when a new provider is implemented.
const adapters=Object.freeze([githubIssueRequirementSource]);
export const supportedRequirementSources=Object.freeze(adapters.map(a=>Object.freeze({kind:a.kind,version:a.version})));
export function requirementSourceAdapter(kind){
  const matches=adapters.filter(a=>a.kind===kind);
  if(matches.length!==1)throw Error('requirement-source:unsupported');
  return matches[0];
}
export function acceptsRequirementSource(source){
  return adapters.filter(a=>a.acceptsSource(source)).length===1;
}
