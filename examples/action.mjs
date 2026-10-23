import { invoke } from '@nibfin/core';
// Schema 2 requires separate productSecurity and delivery references.
// trustedAdapters.requirements supplies host-selected readers, storage and approval verification.
// Called by trusted Core integration after prerequisite/authentication checks.
// No adapter path, token or permission assertion comes from workflow/event inputs.
export const runOneStage = (request, trustedAdapters) => invoke(request, trustedAdapters);
