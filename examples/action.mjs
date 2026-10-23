import { invoke } from '@nibfin/core';
// Called by trusted Core integration after prerequisite/authentication checks.
// No adapter path, token or permission assertion comes from workflow/event inputs.
export const runOneStage = (request, trustedAdapters) => invoke(request, trustedAdapters);
