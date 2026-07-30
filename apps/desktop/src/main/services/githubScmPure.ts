const MAX_PROVIDER_PAYLOAD_CHARS = 64 * 1024;
const MAX_REPOSITORY_NAME = 100;
const MAX_REPOSITORY_DESCRIPTION = 350;

export const GITHUB_DEVICE_CODE_ENDPOINT = 'https://github.com/login/device/code';
export const GITHUB_ACCESS_ENDPOINT = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_ENDPOINT = 'https://api.github.com/user';
export const GITHUB_REPOSITORIES_ENDPOINT = 'https://api.github.com/user/repos';
export const GITHUB_VERIFICATION_URL = 'https://github.com/login/device';

export interface ParsedDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: typeof GITHUB_VERIFICATION_URL;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type ParsedDevicePoll =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | {
      kind: 'success';
      accessToken: string;
      scopes: string[];
    }
  | {
      kind: 'terminal';
      code: 'expired' | 'access_denied' | 'device_flow_disabled' | 'provider_error';
      message: string;
    };

export interface ValidatedRepositoryInput {
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was malformed.`);
  }
  return value as Record<string, unknown>;
}

function boundedProviderString(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`GitHub returned an invalid ${key}.`);
  }
  return value;
}

function boundedInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`GitHub returned an invalid ${key}.`);
  }
  return value as number;
}

export function parseBoundedJson(text: string): unknown {
  if (text.length === 0 || text.length > MAX_PROVIDER_PAYLOAD_CHARS) {
    throw new Error('GitHub returned an invalid response size.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('GitHub returned malformed JSON.');
  }
}

export function parseScopeList(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 1_024) return [];
  const scopes = value
    .split(/[\s,]+/)
    .map((scope) => scope.trim().toLowerCase())
    .filter((scope) => /^[a-z][a-z0-9:_-]{0,63}$/.test(scope));
  return [...new Set(scopes)].slice(0, 32).sort();
}

export function parseDeviceCodePayload(value: unknown): ParsedDeviceCode {
  const record = recordOf(value, 'GitHub device authorization response');
  const deviceCode = boundedProviderString(record, 'device_code', 512);
  const userCode = boundedProviderString(record, 'user_code', 32).toUpperCase();
  const verificationUrl = boundedProviderString(record, 'verification_uri', 128);
  const expiresInSeconds = boundedInteger(record, 'expires_in', 30, 1_800);
  const intervalSeconds = boundedInteger(record, 'interval', 1, 60);

  if (!/^[A-Z0-9-]{4,32}$/.test(userCode)) {
    throw new Error('GitHub returned an invalid user code.');
  }
  if (verificationUrl !== GITHUB_VERIFICATION_URL) {
    throw new Error('GitHub returned an unexpected verification address.');
  }
  if (!/^[A-Za-z0-9._~-]{8,512}$/.test(deviceCode)) {
    throw new Error('GitHub returned an invalid device code.');
  }

  return {
    deviceCode,
    userCode,
    verificationUrl: GITHUB_VERIFICATION_URL,
    expiresInSeconds,
    intervalSeconds,
  };
}

export function parseDevicePollPayload(value: unknown): ParsedDevicePoll {
  const record = recordOf(value, 'GitHub device authorization response');
  const error = record.error;
  if (typeof error === 'string') {
    switch (error) {
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slow_down' };
      case 'expired_token':
        return {
          kind: 'terminal',
          code: 'expired',
          message: 'The GitHub device code expired. Start a new connection.',
        };
      case 'access_denied':
        return {
          kind: 'terminal',
          code: 'access_denied',
          message: 'GitHub authorization was denied.',
        };
      case 'device_flow_disabled':
      case 'unsupported_grant_type':
      case 'incorrect_device_code':
        return {
          kind: 'terminal',
          code: 'device_flow_disabled',
          message: 'GitHub Device Flow is unavailable for this OAuth application.',
        };
      default:
        return {
          kind: 'terminal',
          code: 'provider_error',
          message: 'GitHub could not complete device authorization.',
        };
    }
  }

  const accessToken = boundedProviderString(record, 'access_token', 512);
  const tokenType = boundedProviderString(record, 'token_type', 32).toLowerCase();
  if (tokenType !== 'bearer' || !/^[A-Za-z0-9._~-]{8,512}$/.test(accessToken)) {
    throw new Error('GitHub returned malformed authorization credentials.');
  }
  return {
    kind: 'success',
    accessToken,
    scopes: parseScopeList(record.scope),
  };
}

export function nextDevicePollIntervalSeconds(current: number, slowDown: boolean): number {
  const safeCurrent = Number.isInteger(current) ? Math.min(120, Math.max(1, current)) : 5;
  return slowDown ? Math.min(120, safeCurrent + 5) : safeCurrent;
}

export function validateGithubRepositoryName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Repository name must be a string.');
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > MAX_REPOSITORY_NAME ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.') ||
    name.toLowerCase().endsWith('.git')
  ) {
    throw new Error(
      'Repository name must be 1–100 characters using letters, numbers, periods, hyphens, or underscores.',
    );
  }
  return name;
}

export function validateRepositoryInput(value: unknown): ValidatedRepositoryInput {
  const record = recordOf(value, 'Repository request');
  const name = validateGithubRepositoryName(record.name);
  const visibility = record.visibility;
  if (visibility !== 'public' && visibility !== 'private') {
    throw new Error('Repository visibility must be public or private.');
  }
  if (record.description !== undefined && record.description !== null) {
    if (typeof record.description !== 'string') {
      throw new TypeError('Repository description must be a string.');
    }
    if (record.description.length > MAX_REPOSITORY_DESCRIPTION) {
      throw new Error('Repository description must be 350 characters or fewer.');
    }
  }
  const description =
    typeof record.description === 'string' && record.description.trim().length > 0
      ? record.description.trim()
      : null;
  return { name, description, visibility };
}

export function validateRemoteName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Remote name must be a string.');
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name === '.' || name === '..') {
    throw new Error('Remote name contains unsupported characters.');
  }
  return name;
}

export function validateBranchRef(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Branch reference must be a string.');
  const ref = value.trim();
  if (
    ref.length === 0 ||
    ref.length > 255 ||
    ref === '@' ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    ref
      .split('/')
      .some((part) => part.length === 0 || part.startsWith('.') || part.endsWith('.lock')) ||
    /[\u0000-\u0020\u007f~^:?*\\[]/.test(ref)
  ) {
    throw new Error('Branch reference is not a valid safe Git ref.');
  }
  return ref;
}

function exactUrl(raw: unknown): URL {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 512 ||
    raw.includes('%') ||
    !raw.startsWith('https://github.com/')
  ) {
    throw new Error('GitHub repository URL is invalid.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GitHub repository URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('GitHub repository URL must use credential-free HTTPS on github.com.');
  }
  return url;
}

export function validateGithubCloneUrl(raw: unknown): string {
  const url = exactUrl(raw);
  const match = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\.git$/.exec(url.pathname);
  if (!match) throw new Error('GitHub clone URL has an invalid repository path.');
  validateGithubRepositoryName(match[2]);
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

export function validateGithubHtmlUrl(raw: unknown): string {
  const url = exactUrl(raw);
  const match = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(url.pathname);
  if (!match) throw new Error('GitHub repository URL has an invalid repository path.');
  validateGithubRepositoryName(match[2]);
  return `https://github.com/${match[1]}/${match[2]}`;
}

export function isExactGithubCloneUrl(raw: string): boolean {
  try {
    return validateGithubCloneUrl(raw) === raw;
  } catch {
    return false;
  }
}

export function validateGithubRemoteUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('GitHub remote URL is invalid.');
  try {
    const clone = validateGithubCloneUrl(raw);
    if (clone === raw) return clone;
  } catch {
    // Canonical Git remotes may omit the optional .git suffix.
  }
  const html = validateGithubHtmlUrl(raw);
  if (html !== raw) throw new Error('GitHub remote URL is not canonical.');
  return html;
}

export function isExactGithubRemoteUrl(raw: string): boolean {
  try {
    return validateGithubRemoteUrl(raw) === raw;
  } catch {
    return false;
  }
}
