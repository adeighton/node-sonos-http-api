/** Raised when settings.json, a preset file or the environment cannot be turned into valid config. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length === 0 ? message : `${message}:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
