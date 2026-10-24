import {githubId, repositoryCoordinates} from './index.mjs';

export const concurrencyVersion = 1;
/** Trusted resolved identities only; never pass raw event expressions or names. */
export function nativeConcurrency({repository, repositoryId, issue, scope, queue = 'max', cancelInProgress = false}) {
  const parts = repository?.split('/');
  if (parts?.length !== 2) throw Error('concurrency:repository');
  repositoryCoordinates(...parts);
  githubId(repositoryId);
  if (!['issue', 'repository-write'].includes(scope) || !['single', 'max'].includes(queue)
      || cancelInProgress !== false) throw Error('concurrency:configuration');
  if (scope === 'issue') githubId(issue);
  else if (issue !== undefined) throw Error('concurrency:scope');
  // Stable ID keeps protection intact across case changes and repository renames.
  return Object.freeze({group: `nibfin-v1-${repositoryId}-${scope}${scope === 'issue' ? '-' + issue : ''}`,
    'cancel-in-progress': false, queue});
}
export function parallelIssueWorkspace({repositoryId, issue, cycle}) {
  githubId(repositoryId); githubId(issue);
  if (typeof cycle !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(cycle)) throw Error('concurrency:cycle');
  const key = `${repositoryId}/${issue}/${cycle}`;
  return {branch: `nibfin/issue/${key}`, directory: `work/${key}`};
}
/** maxParallel bounds one workflow's computation matrix only, across neither Runs nor repos. */
export function nativeExecutionPlan({repository, repositoryId, issue, cycle, maxParallel, parallelScope = 'workflow-matrix', queue = 'max'}) {
  if (parallelScope !== 'workflow-matrix' || !Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > 256)
    throw Error('concurrency:parallelism');
  return {version: concurrencyVersion, parallelScope,
    workspace: parallelIssueWorkspace({repositoryId, issue, cycle}),
    concurrency: nativeConcurrency({repository, repositoryId, issue, scope: 'issue', queue}),
    jobs: {
      compute: {strategy: {'max-parallel': maxParallel}},
      write: {needs: ['compute'], concurrency: nativeConcurrency({repository, repositoryId, scope: 'repository-write', queue})}
    }};
}
