const ALLOWED_PROCESS_ENVIRONMENT_KEYS = [
  'SystemRoot',
  'WINDIR',
  'windir',
  'PATH',
  'Path',
  'PATHEXT',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
] as const;

export interface ChildProcessEnvironmentOptions {
  ci?: boolean;
  color?: boolean;
}

/**
 * Build a minimal environment for non-interactive child processes.
 *
 * Main may hold provider, GitHub, collaboration, and deployment credentials in
 * its ambient environment. Child processes never inherit that object; callers
 * must add any narrowly required, non-secret protocol variable explicitly.
 */
export function buildChildProcessEnvironment(
  options: ChildProcessEnvironmentOptions = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_PROCESS_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === 'string') environment[key] = value;
  }
  if (options.ci) environment.CI = 'true';
  if (options.color === false) {
    environment.NO_COLOR = '1';
    environment.FORCE_COLOR = '0';
  } else if (options.color === true) {
    environment.FORCE_COLOR = '1';
  }
  return environment;
}
