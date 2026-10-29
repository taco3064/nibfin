import assert from 'node:assert/strict';
import { digest } from '../src/core.mjs';

// Synthetic workspace support for actual Runtime repair transitions. This
// preserves candidate identities; it is not Git or native restoration evidence.
export function withRepairSnapshot(workspace) {
  return { ...workspace,
    async git(args) {
      assert.deepEqual(args.slice(0, 3), ['diff', '--binary', '--no-ext-diff']);
      return this.diff(args[3]);
    },
    async snapshotCandidate(candidate) {
      assert.equal(digest(await this.capture(candidate.base, true, candidate.obligations)), digest(candidate), 'Fixture source changed');
      return { candidate: structuredClone(candidate), candidateHash: digest(candidate), commit: digest({ fixtureSnapshot: candidate }).slice(0, 40) };
    },
    async snapshotRepair(base, obligations) {
      return {...await this.snapshotCandidate(await this.capture(base, true, obligations)), unaccepted:true, missingOutputs:[]};
    },
    async restoreRepair(source, seed, base) {
      assert.equal(seed.candidateHash, digest(seed.candidate), 'Fixture seed changed');
      assert.equal((await source.snapshotCandidate(seed.candidate)).commit, seed.commit, 'Fixture source commit changed');
      await this.prepare(base);
      const restored = await this.capture(base, true, seed.candidate.obligations);
      assert.equal(restored.repository, seed.candidate.repository);
      assert.equal(restored.tree, seed.candidate.tree, 'Fixture tree was not preserved');
      return { status: 'restored', sourceCandidateHash: seed.candidateHash, base, conflicts: [] };
    }
  };
}
