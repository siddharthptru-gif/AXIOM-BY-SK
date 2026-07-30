export interface AskpassExchangeReply {
  value: string;
  complete: boolean;
}

const GITHUB_PATH = '(?:/[A-Za-z0-9._/-]{1,180})?';
const USERNAME_PROMPT = new RegExp(`^Username for 'https://github\\.com${GITHUB_PATH}': ?$`, 'i');
const PASSWORD_PROMPT = new RegExp(
  `^Password for 'https://x-access-token@github\\.com${GITHUB_PATH}': ?$`,
  'i',
);

/** Strictly accepts one GitHub username prompt followed by one password prompt. */
export class AskpassExchange {
  private step: 0 | 1 | 2 = 0;
  private closed = false;

  constructor(private readonly access: string) {}

  answer(prompt: unknown): AskpassExchangeReply | null {
    if (this.closed || typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 512) {
      this.closed = true;
      return null;
    }
    if (this.step === 0 && USERNAME_PROMPT.test(prompt)) {
      this.step = 1;
      return { value: 'x-access-token', complete: false };
    }
    if (this.step === 1 && PASSWORD_PROMPT.test(prompt)) {
      this.step = 2;
      this.closed = true;
      return { value: this.access, complete: true };
    }
    this.closed = true;
    return null;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

const ALLOWED_ENVIRONMENT_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'PROGRAMDATA',
  'SSH_AUTH_SOCK',
] as const;

/** Construct a minimal, noninteractive Git/SSH environment without inherited dispatch hooks. */
export function buildSelectedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === 'string') environment[key] = value;
  }
  environment['GIT_TERMINAL_PROMPT'] = '0';
  environment['GCM_INTERACTIVE'] = 'Never';
  environment['SSH_ASKPASS_REQUIRE'] = 'never';
  environment['GIT_SSH_COMMAND'] = 'ssh -oBatchMode=yes -oNumberOfPasswordPrompts=0';
  environment['GIT_CONFIG_COUNT'] = '2';
  environment['GIT_CONFIG_KEY_0'] = 'credential.helper';
  environment['GIT_CONFIG_VALUE_0'] = '';
  environment['GIT_CONFIG_KEY_1'] = 'core.askPass';
  environment['GIT_CONFIG_VALUE_1'] = '';
  environment['LC_ALL'] = 'C';
  return environment;
}

export function buildExplicitPushArguments(
  remote: string,
  sourceBranch: string,
  destinationBranch: string,
  setUpstream: boolean,
): string[] {
  return [
    'push',
    ...(setUpstream ? ['--set-upstream'] : []),
    remote,
    `${sourceBranch}:${destinationBranch}`,
  ];
}

export function buildExplicitFetchArguments(remote: string, remoteBranch?: string): string[] {
  return ['fetch', '--prune', remote, ...(remoteBranch ? [remoteBranch] : [])];
}

export function canonicalOriginMatches(
  fetchUrl: string,
  pushUrl: string,
  cloneUrl: string,
): boolean {
  return fetchUrl === cloneUrl && pushUrl === cloneUrl;
}
