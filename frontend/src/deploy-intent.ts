// deployIntent hands the deploy page an "edit this stack" target without relying
// on a query string — loom's history router strips query strings when routing
// (`/deploy?edit=x` -> `/deploy`), so the edit target would be lost. The stack
// page sets `edit` right before navigating to /deploy; the deploy page reads and
// clears it on mount.
export const deployIntent: { edit: string | null } = { edit: null };
