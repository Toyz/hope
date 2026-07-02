// DeployIntent hands the deploy page an "edit this stack" target without relying
// on a query string — loom's history router strips query strings when routing
// (`/deploy?edit=x` -> `/deploy`), so the edit target would be lost. The stack
// page sets `edit` right before navigating to /deploy; the deploy page take()s it
// on mount (read + clear). A DI service instead of a module-level global so it's
// typed and injectable like every other cross-page dependency.
export class DeployIntent {
  edit: string | null = null;

  // Read the pending edit target and clear it (one-shot handoff).
  take(): string | null {
    const v = this.edit;
    this.edit = null;
    return v;
  }
}
