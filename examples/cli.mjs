import { verifyInstallation } from '@nibfin/core/identity';
// Expected identity comes from an independently trusted pinned installation record.
// This is an installer library example, not a new gh nibfin command.
export const checkInstalledCore = expected => verifyInstallation(expected);
