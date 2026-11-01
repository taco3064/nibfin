// Labels are workflow progress observations, never execution permissions.
export function workflowLabels(labels) {
  if (
    !Array.isArray(labels) ||
    labels.length > 1000 ||
    labels.some(
      (label) =>
        !label ||
        typeof label.name !== 'string' ||
        label.name.length === 0 ||
        label.name.length > 256,
    ) ||
    new Set(labels.map((label) => label.name)).size !== labels.length
  )
    throw Error('workflow-labels:invalid');
  return new Set(labels.map((label) => label.name));
}

export function deliveredWorkflowProgress(issue) {
  const names = workflowLabels(issue.labels);
  if (!names.has('delivered')) return false;
  if (
    !names.has('scope') ||
    !names.has('shaped') ||
    issue.state !== 'closed' ||
    ![null, undefined, 'completed'].includes(issue.state_reason)
  )
    throw Error('workflow-labels:inconsistent-delivery');
  return true;
}
