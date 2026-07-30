'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const desktop = path.resolve(__dirname, '..');
const root = path.resolve(desktop, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const mustThrow = (fn, message) => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
};

function loadPureTypeScript(relative) {
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const execute = new Function('module', 'exports', 'require', output);
  execute(module, module.exports, require);
  return module.exports;
}

function loadTypeScriptWithMocks(relative, mocks) {
  const filename = path.join(root, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const mockedRequire = (specifier) =>
    Object.prototype.hasOwnProperty.call(mocks, specifier) ? mocks[specifier] : require(specifier);
  const execute = new Function('module', 'exports', 'require', output);
  execute(module, module.exports, mockedRequire);
  return module.exports;
}

const purePath = 'apps/desktop/src/main/services/githubScmPure.ts';
const servicePath = 'apps/desktop/src/main/services/githubScm.ts';
const machinePath = 'apps/desktop/src/main/services/githubDeviceFlow.ts';
const systemPath = 'apps/desktop/src/main/services/systemGit.ts';
const securityPath = 'apps/desktop/src/main/services/systemGitSecurity.ts';
const ipcPath = 'apps/desktop/src/common/ipc.ts';
const mainIpcPath = 'apps/desktop/src/main/ipc.ts';
const preloadPath = 'apps/desktop/src/preload/index.ts';
const envPath = 'apps/desktop/src/renderer/src/env.d.ts';
const scmPath = 'apps/desktop/src/renderer/src/workbench/ScmView.tsx';
const gatePath = 'apps/desktop/src/renderer/src/workbench/scmRequestGate.ts';
const modalPath = 'apps/desktop/src/renderer/src/workbench/Modal.tsx';
const appPath = 'apps/desktop/src/renderer/src/App.tsx';
const busPath = 'apps/desktop/src/renderer/src/commands/commandBuses.ts';

const pureSource = read(purePath);
const serviceSource = read(servicePath);
const machineSource = read(machinePath);
const systemSource = read(systemPath);
const securitySource = read(securityPath);
const ipcSource = read(ipcPath);
const mainIpcSource = read(mainIpcPath);
const preloadSource = read(preloadPath);
const envSource = read(envPath);
const scmSource = read(scmPath);
const gateSource = read(gatePath);
const modalSource = read(modalPath);
const appSource = read(appPath);
const busSource = read(busPath);
const packageJson = JSON.parse(read('apps/desktop/package.json'));
const rootPackageJson = JSON.parse(read('package.json'));
const lockJson = JSON.parse(read('package-lock.json'));
const pure = loadPureTypeScript(purePath);
const deviceFlow = loadPureTypeScript(machinePath);
const gitSecurity = loadPureTypeScript(securityPath);
const scmGate = loadPureTypeScript(gatePath);
const commandBus = loadPureTypeScript(busPath);

// Fixed origins and pure URL/input validation.
assert(
  pure.GITHUB_DEVICE_CODE_ENDPOINT === 'https://github.com/login/device/code',
  'Device-code endpoint must be fixed.',
);
assert(
  pure.GITHUB_ACCESS_ENDPOINT === 'https://github.com/login/oauth/access_token',
  'Access endpoint must be fixed.',
);
assert(pure.GITHUB_USER_ENDPOINT === 'https://api.github.com/user', 'User endpoint must be fixed.');
assert(
  pure.GITHUB_REPOSITORIES_ENDPOINT === 'https://api.github.com/user/repos',
  'Repository endpoint must be fixed.',
);
assert(
  pure.validateGithubCloneUrl('https://github.com/octocat/example.git') ===
    'https://github.com/octocat/example.git',
  'Canonical GitHub clone URL should validate.',
);
assert(
  pure.validateGithubRemoteUrl('https://github.com/octocat/example') ===
    'https://github.com/octocat/example',
  'Canonical suffix-free GitHub remote should validate.',
);
for (const invalid of [
  'http://github.com/octocat/example.git',
  'https://user@github.com/octocat/example.git',
  'https://github.com:443/octocat/example.git',
  'https://github.com/octocat/example.git?x=1',
  'https://github.com/octocat/example.git#x',
  'https://example.com/octocat/example.git',
]) {
  mustThrow(() => pure.validateGithubCloneUrl(invalid), `Unsafe GitHub URL accepted: ${invalid}`);
}
assert(
  pure.validateGithubRepositoryName('axiom.repo-1') === 'axiom.repo-1',
  'Valid name rejected.',
);
assert(pure.validateGithubRepositoryName('.github') === '.github', 'Valid .github name rejected.');
for (const invalid of ['', '.', '..', 'repo.', 'repo.git', 'bad/name', 'x'.repeat(101)]) {
  mustThrow(
    () => pure.validateGithubRepositoryName(invalid),
    `Invalid repository name accepted: ${invalid}`,
  );
}
assert(pure.validateRemoteName('origin') === 'origin', 'Valid remote name rejected.');
assert(
  pure.validateBranchRef('feature/github-scm') === 'feature/github-scm',
  'Valid ref rejected.',
);
for (const invalid of ['-main', 'bad..ref', 'bad ref', 'bad~ref', 'bad@{ref', 'refs/.hidden']) {
  mustThrow(() => pure.validateBranchRef(invalid), `Invalid branch ref accepted: ${invalid}`);
}
mustThrow(
  () =>
    pure.validateRepositoryInput({
      name: 'repo',
      description: 'x'.repeat(351),
      visibility: 'private',
    }),
  'Oversized repository description was accepted.',
);

// Device Flow parser, malformed responses, terminal cases, and +5 second slow_down.
const device = pure.parseDeviceCodePayload({
  device_code: 'device-code-123456',
  user_code: 'abcd-efgh',
  verification_uri: pure.GITHUB_VERIFICATION_URL,
  expires_in: 900,
  interval: 5,
});
assert(device.userCode === 'ABCD-EFGH', 'Device code was not sanitized.');
assert(
  pure.parseDevicePollPayload({ error: 'authorization_pending' }).kind === 'pending',
  'Pending lost.',
);
assert(pure.parseDevicePollPayload({ error: 'slow_down' }).kind === 'slow_down', 'slow_down lost.');
assert(
  pure.nextDevicePollIntervalSeconds(5, true) === 10,
  'slow_down must increase the interval by five seconds.',
);
assert(
  pure.parseDevicePollPayload({ error: 'access_denied' }).code === 'access_denied',
  'access_denied must be terminal.',
);
assert(
  pure.parseDevicePollPayload({ error: 'device_flow_disabled' }).code === 'device_flow_disabled',
  'device_flow_disabled must be terminal.',
);
mustThrow(() => pure.parseDeviceCodePayload({}), 'Malformed Device Flow response was accepted.');
mustThrow(
  () => pure.parseBoundedJson('x'.repeat(65 * 1024)),
  'Oversized provider payload was accepted.',
);
const reflectedOauthMarker = 'reflected-oauth-marker';
const fixedOauthFailure = pure.parseDevicePollPayload({
  error: 'unexpected_provider_failure',
  error_description: reflectedOauthMarker,
});
assert(fixedOauthFailure.kind === 'terminal', 'Unknown OAuth failure was not terminal.');
assert(
  !JSON.stringify(fixedOauthFailure).includes(reflectedOauthMarker),
  'OAuth provider description was reflected.',
);

// Credential-bearing values stay Main-only and fixed requests are bounded.
const githubContract = ipcSource.slice(
  ipcSource.indexOf('export interface GithubAccount'),
  ipcSource.indexOf('export interface AiConnectionInput'),
);
assert(
  !/^\s*(?:accessToken|token|secret|credential)\??\s*:/im.test(githubContract),
  'Credential field leaked into common GitHub IPC types.',
);
for (const rendererContract of [preloadSource, envSource]) {
  const start = rendererContract.indexOf('github: {');
  const end = rendererContract.indexOf('secrets:', start);
  const githubApi = rendererContract.slice(start, end);
  assert(start >= 0 && end > start, 'Renderer GitHub API block is missing.');
  assert(
    !/(?:get|read|set).*?(?:token|credential)/i.test(githubApi),
    'Renderer exposes a credential method.',
  );
  assert(!/accessToken/i.test(githubApi), 'Renderer exposes an authorization credential.');
}
const forbiddenClientField = ['client', 'secret'].join('_');
for (const source of [
  pureSource,
  serviceSource,
  machineSource,
  systemSource,
  securitySource,
  ipcSource,
  mainIpcSource,
  preloadSource,
  envSource,
  scmSource,
  gateSource,
]) {
  assert(
    !source.toLowerCase().includes(forbiddenClientField),
    'A confidential OAuth field appears in production SCM source.',
  );
}
assert(
  serviceSource.includes("const DEFAULT_PUBLIC_CLIENT_ID = 'Ov23liwAEf5dBY6BeewD'"),
  'The fixed public OAuth client id changed.',
);
assert(
  !serviceSource.includes('AXIOM_GITHUB_OAUTH_CLIENT_ID'),
  'An unconstrained OAuth client override remains.',
);
assert(
  serviceSource.includes('MAX_RESPONSE_BYTES = 64 * 1024'),
  'GitHub responses are not bounded.',
);
assert(serviceSource.includes("redirect: 'error'"), 'GitHub redirects must be rejected.');
assert(
  machineSource.indexOf('const validated = await this.dependencies.validateAccount') <
    machineSource.indexOf('await this.dependencies.persistCredential'),
  'Credential is persisted before account validation.',
);
assert(
  machineSource.includes('const before = this.inactiveKind(flow)') &&
    machineSource.includes('const after = this.inactiveKind(flow)'),
  'Credential persistence lacks immediate before/after flow checks.',
);
assert(
  machineSource.includes('this.credentialEpoch += 1'),
  'Disconnect does not synchronously advance the credential epoch.',
);

// 401 invalidation and dedicated encrypted Main storage.
assert(
  serviceSource.includes("const STORAGE_KEY = 'axiom.github.oauth.device-flow.v1'"),
  'Dedicated storage key missing.',
);
assert(
  serviceSource.includes('authStorage.setItem(STORAGE_KEY'),
  'Credential is not stored through authStorage.',
);
assert(
  (serviceSource.match(/response\.status === 401/g) || []).length >= 2,
  '401 invalidation paths are missing.',
);
assert(
  (serviceSource.match(/authStorage\.removeItem\(STORAGE_KEY\)/g) || []).length >= 3,
  '401/disconnect invalidation does not clear storage.',
);
// Consistency with the root release, not a literal pin, so a bump does not fail
// this gate while a mismatched workspace version still does.
assert(
  /^\d+\.\d+\.\d+$/.test(rootPackageJson.version),
  `Root application version is not a plain semver release: ${rootPackageJson.version}`,
);
assert(
  packageJson.version === rootPackageJson.version,
  `Desktop version ${packageJson.version} does not match root ${rootPackageJson.version}.`,
);
const logoHash = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(root, 'apps/desktop/build/logo.png')))
  .digest('hex')
  .toUpperCase();
assert(
  logoHash === 'E6137563C6F63E2B0C0E4AA2A1F1B3FD1416008136F10F363440BFEDDE11D7E2',
  `Official logo changed: ${logoHash}`,
);

// Exact dependency pin in manifest and lockfile.
assert(
  packageJson.dependencies['simple-git'] === '3.36.0',
  'simple-git must remain exactly pinned.',
);
assert(
  lockJson.packages['node_modules/simple-git'].version === '3.36.0',
  'Lockfile simple-git version changed.',
);

// Askpass must be operation-scoped, named-pipe based, bounded, noninteractive, and secret-free in env/argv/URLs.
assert(systemSource.includes('createServer('), 'Askpass broker is not a local server.');
assert(
  systemSource.includes('pipe\\\\axiom-git-askpass-') ||
    systemSource.includes('pipe\\axiom-git-askpass-'),
  'Windows unpredictable named pipe missing.',
);
assert(systemSource.includes('randomBytes(20)'), 'Askpass pipe name is not unpredictable.');
assert(systemSource.includes('nonceMatches('), 'Askpass nonce validation missing.');
assert(systemSource.includes('MAX_ASKPASS_REQUESTS = 2'), 'Askpass request cap must be two.');
assert(
  securitySource.includes("environment['GIT_TERMINAL_PROMPT'] = '0'"),
  'Terminal prompts are not disabled.',
);
assert(
  securitySource.includes("environment['GCM_INTERACTIVE'] = 'Never'"),
  'Credential-manager interaction is not disabled.',
);
assert(
  securitySource.includes("environment['GIT_CONFIG_KEY_0'] = 'credential.helper'"),
  'Ambient helper is not disabled for generic Git.',
);
assert(
  securitySource.includes('BatchMode=yes') && securitySource.includes('NumberOfPasswordPrompts=0'),
  'SSH is not forced noninteractive.',
);
assert(
  systemSource.includes("env['GIT_CONFIG_KEY_2'] = 'core.hooksPath'"),
  'Broker hooks are enabled.',
);
assert(
  !/env\[[^\]]+\]\s*=\s*access\b/.test(systemSource),
  'Authorization credential entered child environment.',
);
assert(!/raw\([^\n]*access/.test(systemSource), 'Authorization credential entered Git argv.');
assert(
  !/https?:\/\/\$\{access\}/.test(systemSource),
  'Authorization credential entered a remote URL.',
);
assert(
  systemSource.includes('await fs.rm(temp, { recursive: true, force: true })'),
  'Askpass temporary files are not cleaned in finally.',
);

// Every advanced workspace operation reuses trust/canonical-root checks in Main.
for (const channel of [
  'gitRepository',
  'gitRemotes',
  'gitFetch',
  'gitPull',
  'gitPush',
  'gitAddRemote',
  'gitDeleteBranch',
  'gitMerge',
  'gitRebase',
  'gitCommitAndPush',
  'githubPublishRepository',
  'githubRetryPublishRepository',
]) {
  const index = mainIpcSource.indexOf(`IPC.${channel}`);
  assert(index >= 0, `Missing Main handler: ${channel}`);
  assert(
    mainIpcSource.slice(index, index + 900).includes('trustedWorkspaceRoot'),
    `${channel} bypasses trustedWorkspaceRoot.`,
  );
}
assert(
  mainIpcSource.includes('Discarding changes requires explicit confirmation.'),
  'Destructive discard does not require Main-validated confirmation.',
);
assert(
  mainIpcSource.includes('trustedGitTarget(root, filepath'),
  'Existing path-contained Git target guard was removed.',
);
for (const source of [ipcSource, mainIpcSource, preloadSource, envSource, scmSource]) {
  assert(!source.includes('githubCreateRepository'), 'Standalone repository creation IPC remains.');
  assert(!source.includes('createRepository:'), 'Standalone renderer creation API remains.');
}
assert(
  mainIpcSource.includes('Publishing a GitHub repository requires explicit confirmation.'),
  'Publish confirmation is not Main-validated.',
);
assert(
  mainIpcSource.includes('Retrying a GitHub publication requires explicit confirmation.'),
  'Publish retry confirmation is not Main-validated.',
);
assert(
  systemSource.includes("import { assertWorkspaceTrusted } from './workspaceTrust'"),
  'System Git does not reuse authoritative workspace trust.',
);
assert(
  systemSource.includes('await assertTrustedRootUnchanged(root)'),
  'System Git does not revalidate canonical trust inside serialized work.',
);

// Owner-bound command/flow buses, complete operations, Commit & Push, and publish recovery.
for (const command of [
  'view',
  'refresh',
  'fetch',
  'pull',
  'push',
  'commit-and-push',
  'connect',
  'disconnect',
]) {
  assert(busSource.includes(`'${command}'`), `Buffered SCM command missing: ${command}`);
}
assert(busSource.includes('scmDelivery = scmDelivery'), 'SCM commands are not serialized.');
assert(
  scmSource.includes('setScmCommandHandler('),
  'ScmView does not own the buffered command handler.',
);
assert(
  scmSource.includes('commandHandlerRef.current'),
  'SCM command owner does not avoid stale closures.',
);
assert(serviceSource.includes('ownerId: number'), 'Device Flow is not renderer-owner-bound.');
assert(
  serviceSource.includes("randomBytes(24).toString('base64url')"),
  'Device Flow id is not opaque/random.',
);
assert(
  mainIpcSource.includes('cancelGithubFlowsForOwner(ownerId)'),
  'Renderer destruction does not cancel Device Flow.',
);
assert(preloadSource.includes('commitAndPush:'), 'Commit & Push bridge missing.');
assert(scmSource.includes('Commit &amp; Push'), 'Commit & Push UI missing.');
assert(
  systemSource.includes('Commit ${oid.slice(0, 7)} was created, but push failed'),
  'Commit & Push recovery is missing.',
);
assert(systemSource.includes('class PartialPublishError'), 'Partial publish state is not modeled.');
assert(
  mainIpcSource.includes("stage === 'remote-added'"),
  'Partial publish recovery stage is not surfaced.',
);
assert(
  mainIpcSource.includes('repository.htmlUrl'),
  'Partial publish recovery omits the repository URL.',
);

// Sanitized renderer output and command palette wiring.
assert(systemSource.includes('sanitizeRemoteUrl('), 'Remote output is not sanitized.');
assert(
  systemSource.includes("url.username = ''") && systemSource.includes("url.password = ''"),
  'Remote credentials are not stripped.',
);
assert(
  scmSource.includes('window.axiom.github.poll(flowId)'),
  'Renderer does not automatically request Main polling.',
);
assert(
  scmSource.includes('announce(next.message'),
  'SCM progress does not use the central live region.',
);
assert(!scmSource.includes('aria-live='), 'ScmView creates a competing live region.');
assert(appSource.includes("requestScmCommand('connect')"), 'Connect palette command missing.');
assert(
  appSource.includes("requestScmCommand('disconnect')"),
  'Disconnect palette command missing.',
);

// Destination, partial-result, least-privilege, and accessibility contracts.
assert(!systemSource.includes("git.raw(['push'])"), 'A bare push path remains.');
assert(
  systemSource.includes('buildExplicitPushArguments(remote.name, branch, remoteBranch, false)') &&
    systemSource.includes("buildExplicitPushArguments('origin', branch, branch, true)"),
  'Explicit source:destination push plans are missing.',
);
assert(
  systemSource.includes('canonicalOriginMatches(origin.refs.fetch, origin.refs.push, cloneUrl)'),
  'Publish does not require both origin URLs to match.',
);
assert(
  systemSource.includes("'FETCH_HEAD'") && !systemSource.includes("git.raw(['pull'"),
  'Pull is not split into fetch and credential-free merge.',
);
assert(
  ipcSource.includes("outcome: 'partial'") && ipcSource.includes('commitOid?: string'),
  'Typed partial Git operation result is missing.',
);
assert(
  scmSource.includes("result.outcome === 'partial'") &&
    scmSource.includes('Retry Push') &&
    scmSource.includes('window.axiom.github.retryPublish'),
  'Renderer partial recovery card or canonical retry is missing.',
);
assert(
  scmSource.includes('const captured = gate?.snapshot()') &&
    scmSource.includes('gate.isCurrent(captured)') &&
    scmSource.includes("gate?.begin('status')") &&
    scmSource.includes("gate?.begin('history')"),
  'SCM root/generation/request guards are missing.',
);
assert(scmSource.includes('className="scm-row-open"'), 'SCM diff-open button is missing.');
assert(!/className="scm-row"[^>]*onClick=/.test(scmSource), 'SCM row container remains clickable.');
assert(
  scmSource.includes('`Stage ${c.path}`') &&
    scmSource.includes('`Unstage ${c.path}`') &&
    scmSource.includes('`Discard changes in ${c.path}`'),
  'SCM file action labels omit paths.',
);
assert(
  scmSource.includes('htmlFor={commitMessageId}') && scmSource.includes('id={commitMessageId}'),
  'Commit textarea lacks a real label.',
);
for (const attribute of [
  'role="progressbar"',
  'aria-valuemin={0}',
  'aria-valuemax={100}',
  'aria-valuenow={operationProgress.percent}',
]) {
  assert(scmSource.includes(attribute), `SCM progress is missing ${attribute}.`);
}
assert(!scmSource.includes('aria-live='), 'ScmView creates a competing live region.');
assert(
  modalSource.includes('e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229'),
  'PromptModal does not ignore IME Enter.',
);
assert(
  read('.gitignore')
    .split(/\r?\n/)
    .filter((line) => line === 'process.env.GITHUB_CLIENT_SECRET').length === 1,
  'The exact confidential filename is not ignored exactly once.',
);
// A clean release must also pass when that ignored local artifact has been removed.
// Never require, open, or inspect it from a source/behavior validator.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

const testAccount = {
  id: 1,
  login: 'octocat',
  name: null,
  avatarUrl: null,
  profileUrl: 'https://github.com/octocat',
  scopes: ['repo'],
  repositoryAccess: 'full',
  warning: null,
};
let testFlowSequence = 0;

function makeDeviceHarness(overrides = {}) {
  const state = { now: 0, persisted: [], clears: [] };
  const dependencies = {
    now: () => state.now,
    createId: () => `flow${String(++testFlowSequence).padStart(20, '0')}`,
    startTimeoutMs: 15_000,
    maximumFlows: 32,
    verificationUrl: 'https://github.com/login/device',
    requestDeviceAuthorization: async () => ({
      deviceCode: 'test-device-value',
      userCode: 'TEST-CODE',
      expiresInSeconds: 30,
      intervalSeconds: 1,
    }),
    requestToken: async () => ({
      kind: 'success',
      access: 'test-access-value',
      scopes: ['repo'],
    }),
    validateAccount: async (_access, scopes) => ({ account: testAccount, scopes }),
    persistCredential: async (access, scopes) => {
      state.persisted.push({ access, scopes });
    },
    clearCredential: async (expected) => {
      state.clears.push(expected ?? null);
    },
    wait: async () => undefined,
    nextPollIntervalSeconds: (current, slowDown) => (slowDown ? current + 5 : current),
    ...overrides,
  };
  return { state, machine: new deviceFlow.GithubDeviceFlowMachine(dependencies) };
}

async function runBehavioralTests() {
  // Cancel while account validation is in flight.
  const accountWait = deferred();
  let accountStarted = false;
  const cancelHarness = makeDeviceHarness({
    validateAccount: async () => {
      accountStarted = true;
      return accountWait.promise;
    },
  });
  const cancelFlow = await cancelHarness.machine.start(11);
  const cancelPoll = cancelHarness.machine.poll(11, cancelFlow.flowId);
  await waitFor(() => accountStarted, 'Account validation did not start.');
  cancelHarness.machine.cancel(11, cancelFlow.flowId);
  accountWait.resolve({ account: testAccount, scopes: ['repo'] });
  const cancelResult = await cancelPoll;
  assert(cancelResult.status === 'cancelled', 'Cancel during account request connected the flow.');
  assert(
    cancelHarness.state.persisted.length === 0,
    'Cancelled account request persisted a credential.',
  );

  // Expire while the token request is in flight.
  const tokenWait = deferred();
  let tokenStarted = false;
  let accountCalls = 0;
  const expiryHarness = makeDeviceHarness({
    requestToken: async () => {
      tokenStarted = true;
      return tokenWait.promise;
    },
    validateAccount: async (_access, scopes) => {
      accountCalls += 1;
      return { account: testAccount, scopes };
    },
  });
  const expiryFlow = await expiryHarness.machine.start(12);
  const expiryPoll = expiryHarness.machine.poll(12, expiryFlow.flowId);
  await waitFor(() => tokenStarted, 'Token request did not start.');
  expiryHarness.state.now = expiryFlow.expiresAt;
  tokenWait.resolve({ kind: 'success', access: 'expiry-access-value', scopes: ['repo'] });
  const expiryResult = await expiryPoll;
  assert(expiryResult.status === 'expired', 'In-flight token request ignored flow expiry.');
  assert(accountCalls === 0, 'Expired token result reached account validation.');

  // Disconnect synchronously invalidates an encrypted write in flight.
  const writeWait = deferred();
  let writeStarted = false;
  const disconnectHarness = makeDeviceHarness({
    persistCredential: async () => {
      writeStarted = true;
      await writeWait.promise;
    },
  });
  const disconnectFlow = await disconnectHarness.machine.start(13);
  const disconnectPoll = disconnectHarness.machine.poll(13, disconnectFlow.flowId);
  await waitFor(() => writeStarted, 'Credential write did not start.');
  const disconnected = disconnectHarness.machine.disconnect(13);
  writeWait.resolve();
  const disconnectResult = await disconnectPoll;
  await disconnected;
  assert(disconnectResult.status === 'cancelled', 'Disconnect during write reported connected.');
  assert(disconnectHarness.state.clears.length >= 1, 'Stale encrypted write was not removed.');

  // A later concurrent start owns the generation; the late first response is stale.
  const firstStart = deferred();
  const secondStart = deferred();
  let starts = 0;
  const concurrentHarness = makeDeviceHarness({
    requestDeviceAuthorization: async () => {
      starts += 1;
      return starts === 1 ? firstStart.promise : secondStart.promise;
    },
  });
  const firstOutcome = concurrentHarness.machine.start(14).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const secondOutcome = concurrentHarness.machine.start(14);
  secondStart.resolve({
    deviceCode: 'second-device-value',
    userCode: 'SECOND-CODE',
    expiresInSeconds: 30,
    intervalSeconds: 1,
  });
  firstStart.resolve({
    deviceCode: 'late-first-device-value',
    userCode: 'FIRST-CODE',
    expiresInSeconds: 30,
    intervalSeconds: 1,
  });
  const secondFlow = await secondOutcome;
  const staleFirst = await firstOutcome;
  assert(!staleFirst.ok, 'Late concurrent start remained active.');
  assert(secondFlow.userCode === 'SECOND-CODE', 'Latest owner generation did not win.');
  concurrentHarness.machine.cancel(14, secondFlow.flowId);

  // Reflected flow values never cross the machine result/error boundary.
  const reflectedDevice = 'reflected-device-marker';
  const reflectedAccess = 'reflected-access-marker';
  const reflectedHarness = makeDeviceHarness({
    requestDeviceAuthorization: async () => ({
      deviceCode: reflectedDevice,
      userCode: 'SAFE-CODE',
      expiresInSeconds: 30,
      intervalSeconds: 1,
    }),
    requestToken: async () => ({ kind: 'success', access: reflectedAccess, scopes: ['repo'] }),
    validateAccount: async () => {
      throw new Error(`provider reflected ${reflectedDevice} ${reflectedAccess}`);
    },
  });
  const reflectedFlow = await reflectedHarness.machine.start(15);
  const reflectedResult = await reflectedHarness.machine.poll(15, reflectedFlow.flowId);
  const reflectedJson = JSON.stringify(reflectedResult);
  assert(reflectedResult.status === 'error', 'Reflected provider failure was not fixed.');
  assert(
    !reflectedJson.includes(reflectedDevice) && !reflectedJson.includes(reflectedAccess),
    'Sensitive flow values crossed the result boundary.',
  );

  // Generic Git environment strips inherited dispatch and fails closed.
  const selected = gitSecurity.buildSelectedGitEnvironment({
    PATH: 'test-path',
    GIT_SSH: 'hostile-ssh',
    GIT_SSH_COMMAND: 'hostile-command',
    GIT_ASKPASS: 'hostile-askpass',
  });
  assert(selected.GIT_SSH === undefined, 'Inherited GIT_SSH survived filtering.');
  assert(!String(selected.GIT_SSH_COMMAND).includes('hostile'), 'Inherited SSH command survived.');
  assert(String(selected.GIT_SSH_COMMAND).includes('BatchMode=yes'), 'SSH BatchMode missing.');
  assert(
    String(selected.GIT_SSH_COMMAND).includes('NumberOfPasswordPrompts=0'),
    'SSH password prompt cap missing.',
  );
  assert(selected.GIT_CONFIG_KEY_0 === 'credential.helper', 'Credential helper override missing.');
  assert(selected.GIT_CONFIG_VALUE_0 === '', 'Credential helper is not disabled.');
  assert(selected.GIT_ASKPASS === undefined, 'Generic environment inherited askpass.');

  // Askpass is exactly username then password, and closes after password or any adversarial prompt.
  const exchange = new gitSecurity.AskpassExchange('test-access-value');
  const username = exchange.answer("Username for 'https://github.com/octocat/example.git': ");
  assert(username?.value === 'x-access-token' && !username.complete, 'Username exchange failed.');
  const password = exchange.answer(
    "Password for 'https://x-access-token@github.com/octocat/example.git': ",
  );
  assert(password?.value === 'test-access-value' && password.complete, 'Password exchange failed.');
  assert(
    exchange.answer("Username for 'https://github.com/octocat/example.git': ") === null,
    'Askpass accepted a third request.',
  );
  const outOfOrder = new gitSecurity.AskpassExchange('test-access-value');
  assert(
    outOfOrder.answer("Password for 'https://x-access-token@github.com/octocat/example.git': ") ===
      null,
    'Askpass accepted password before username.',
  );
  assert(
    outOfOrder.answer("Username for 'https://github.com/octocat/example.git': ") === null,
    'Askpass reopened after protocol failure.',
  );
  const foreignPrompt = new gitSecurity.AskpassExchange('test-access-value');
  assert(
    foreignPrompt.answer("Username for 'https://example.com/octocat/example.git': ") === null,
    'Askpass answered a non-GitHub prompt.',
  );

  // Explicit destinations ignore pushRemote/default tracking redirection.
  assert(
    !gitSecurity.canonicalOriginMatches(
      'https://github.com/a/new.git',
      'https://github.com/a/old.git',
      'https://github.com/a/new.git',
    ),
    'Mismatched origin push URL was accepted.',
  );
  assert(
    !gitSecurity.canonicalOriginMatches(
      'https://github.com/a/old.git',
      'https://github.com/a/new.git',
      'https://github.com/a/new.git',
    ),
    'Mismatched origin fetch URL was accepted.',
  );
  assert(
    JSON.stringify(gitSecurity.buildExplicitPushArguments('legacy', 'main', 'stable', false)) ===
      JSON.stringify(['push', 'legacy', 'main:stable']),
    'Existing legacy upstream did not produce an explicit refspec.',
  );
  const publicationPush = gitSecurity.buildExplicitPushArguments('origin', 'main', 'main', true);
  assert(
    JSON.stringify(publicationPush) ===
      JSON.stringify(['push', '--set-upstream', 'origin', 'main:main']),
    'Publication push is not explicit.',
  );
  assert(!publicationPush.includes('redirected-push-remote'), 'pushRemote redirected publication.');

  // Root/trust cycles and request ordering reject stale responses.
  const gate = new scmGate.ScmRequestGate();
  gate.setCapability('A');
  const aStatus = gate.begin('status');
  gate.setCapability('B');
  gate.setCapability('A');
  assert(!gate.accepts(aStatus), 'A-to-B-to-A accepted a stale status response.');
  const trustedA = gate.snapshot();
  gate.setCapability(null);
  gate.setCapability('A');
  assert(!gate.isCurrent(trustedA), 'Revoke-to-retrust accepted an old capability.');
  const firstStatus = gate.begin('status');
  const secondStatus = gate.begin('status');
  assert(
    !gate.accepts(firstStatus) && gate.accepts(secondStatus),
    'Status request ids are not monotonic.',
  );
  const firstHistory = gate.begin('history');
  const secondHistory = gate.begin('history');
  assert(
    !gate.accepts(firstHistory) && gate.accepts(secondHistory),
    'History request ids are not monotonic.',
  );

  // A command queued behind disposed owner A is delivered in order to owner B.
  const ownerStarted = deferred();
  const releaseOwner = deferred();
  const deliveredA = [];
  const deliveredB = [];
  const disposeA = commandBus.setScmCommandHandler(async (command) => {
    deliveredA.push(command);
    ownerStarted.resolve();
    await releaseOwner.promise;
  });
  commandBus.requestScmCommand('refresh');
  await ownerStarted.promise;
  commandBus.requestScmCommand('view');
  disposeA();
  const disposeB = commandBus.setScmCommandHandler(async (command) => {
    deliveredB.push(command);
  });
  releaseOwner.resolve();
  await waitFor(
    () => deliveredB.length === 1,
    'Replacement SCM owner did not receive queued command.',
  );
  disposeB();
  assert(
    JSON.stringify(deliveredA) === JSON.stringify(['refresh']),
    'Disposed owner received queued work.',
  );
  assert(
    JSON.stringify(deliveredB) === JSON.stringify(['view']),
    'Replacement owner lost command order.',
  );

  // Execute production systemGit with injected child/trust dependencies.
  const gitRuntimeState = {
    status: { detached: false, current: 'main', tracking: 'origin/main' },
    remotes: [
      {
        name: 'origin',
        refs: {
          fetch: 'https://github.com/octocat/example.git',
          push: 'https://github.com/octocat/example.git',
        },
      },
    ],
    rawCalls: [],
    rawError: null,
    addError: null,
  };
  const fakeSimpleGit = () => ({
    env() {
      return this;
    },
    async version() {
      return { installed: true, major: 2, minor: 45, patch: 1 };
    },
    async status() {
      return { ...gitRuntimeState.status };
    },
    async getRemotes() {
      return gitRuntimeState.remotes.map((remote) => ({
        name: remote.name,
        refs: { ...remote.refs },
      }));
    },
    async raw(args) {
      gitRuntimeState.rawCalls.push([...args]);
      if (gitRuntimeState.rawError) throw gitRuntimeState.rawError;
      return '';
    },
    async addRemote(name, url) {
      if (gitRuntimeState.addError) throw gitRuntimeState.addError;
      gitRuntimeState.remotes.push({ name, refs: { fetch: url, push: url } });
    },
  });
  const systemGitRuntime = loadTypeScriptWithMocks(systemPath, {
    'simple-git': fakeSimpleGit,
    './githubScm': { getGithubCredentialForGit: async () => null },
    './workspaceTrust': { assertWorkspaceTrusted: async (workspaceRoot) => workspaceRoot },
    './pathAuthorization': {
      canonicalPathIdentity: (workspaceRoot) => workspaceRoot.toLowerCase(),
    },
    './systemGitSecurity': gitSecurity,
    './githubScmPure': pure,
  });
  const commitOid = 'a'.repeat(40);
  gitRuntimeState.rawError = new Error('simulated push failure');
  const partialCommit = await systemGitRuntime.commitAndPush(
    'C:\\trusted-workspace',
    'Test commit',
    async () => commitOid,
  );
  assert(
    partialCommit.outcome === 'partial',
    'Commit push failure rejected instead of returning partial.',
  );
  assert(partialCommit.commitOid === commitOid, 'Partial commit result lost its oid.');
  assert(partialCommit.recovery?.action === 'retry-push', 'Partial commit lacks retry recovery.');
  assert(
    partialCommit.recovery?.repositoryUrl === 'https://github.com/octocat/example.git',
    'Partial commit lost the repository URL.',
  );

  gitRuntimeState.rawError = null;
  const fullCommit = await systemGitRuntime.commitAndPush(
    'C:\\trusted-workspace',
    'Test commit',
    async () => commitOid,
  );
  assert(fullCommit.outcome === 'success', 'Successful commit-and-push was not full success.');

  async function expectPublishStage(
    fetchUrl,
    pushUrl,
    expectedStage,
    addError = null,
    pushError = null,
  ) {
    gitRuntimeState.remotes = fetchUrl
      ? [{ name: 'origin', refs: { fetch: fetchUrl, push: pushUrl } }]
      : [];
    gitRuntimeState.addError = addError;
    gitRuntimeState.rawError = pushError;
    try {
      await systemGitRuntime.publishCreatedRepository(
        'C:\\trusted-workspace',
        'https://github.com/octocat/example.git',
      );
    } catch (error) {
      assert(error.stage === expectedStage, `Unexpected publish recovery stage: ${error.stage}`);
      return;
    } finally {
      gitRuntimeState.addError = null;
      gitRuntimeState.rawError = null;
    }
    throw new Error(`Publish unexpectedly succeeded; expected ${expectedStage}.`);
  }

  await expectPublishStage(
    'https://github.com/octocat/example.git',
    'https://github.com/octocat/legacy.git',
    'repository-created',
  );
  await expectPublishStage(
    'https://github.com/octocat/legacy.git',
    'https://github.com/octocat/example.git',
    'repository-created',
  );
  await expectPublishStage(null, null, 'repository-created', new Error('simulated add failure'));
  gitRuntimeState.status = { detached: false, current: 'main', tracking: 'legacy/old-main' };
  gitRuntimeState.rawCalls = [];
  await expectPublishStage(
    'https://github.com/octocat/example.git',
    'https://github.com/octocat/example.git',
    'remote-added',
    null,
    new Error('simulated publication push failure'),
  );
  assert(
    JSON.stringify(gitRuntimeState.rawCalls.at(-1)) ===
      JSON.stringify(['push', '--set-upstream', 'origin', 'main:main']),
    'Publication followed legacy upstream or pushRemote redirection.',
  );
  gitRuntimeState.remotes = [
    {
      name: 'origin',
      refs: {
        fetch: 'https://github.com/octocat/example.git',
        push: 'https://github.com/octocat/example.git',
      },
    },
  ];
  gitRuntimeState.rawCalls = [];
  const published = await systemGitRuntime.publishCreatedRepository(
    'C:\\trusted-workspace',
    'https://github.com/octocat/example.git',
  );
  assert(published.outcome === 'success', 'Explicit publication did not succeed.');
  assert(
    JSON.stringify(gitRuntimeState.rawCalls.at(-1)) ===
      JSON.stringify(['push', '--set-upstream', 'origin', 'main:main']),
    'Successful publication did not ignore legacy tracking.',
  );

  console.log(
    'GitHub SCM validation passed (behavioral races, transport safety, trust, recovery, and accessibility).',
  );
}

runBehavioralTests().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
