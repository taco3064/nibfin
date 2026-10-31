export class CompletionFailure extends Error {
  constructor(reason, observation) {
    super('completion:' + reason);
    if (observation) this.observation = structuredClone(observation);
  }
}
export const completionNeed = (ok, reason) => {
  if (!ok) throw new CompletionFailure(reason);
};
export const completionTime = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
