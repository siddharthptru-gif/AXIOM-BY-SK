'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const http = require('node:http');

const root = path.resolve(__dirname, '..', '..', '..');
const ts = require(path.join(root, 'node_modules', 'typescript'));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const reject = async (operation, message) => {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
};
const failureCleanups = new Set();

function transpile(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
}

if (!Module._extensions['.ts']) {
  Module._extensions['.ts'] = (loaded, filename) => loaded._compile(transpile(filename), filename);
}

function load(relative, mocks = {}) {
  const filename = path.join(root, relative);
  const output = transpile(filename);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = (specifier) =>
    Object.prototype.hasOwnProperty.call(mocks, specifier) ? mocks[specifier] : original(specifier);
  loaded._compile(output, filename);
  return loaded.exports;
}

function includes(relative, fragment, label) {
  assert(read(relative).includes(fragment), `${label}: missing ${JSON.stringify(fragment)}`);
}

async function validatePureContracts() {
  const god = load('apps/desktop/src/common/godMode.ts');
  assert(god.GOD_MODE_CAPABILITIES.length === 10, 'God Mode must expose exactly ten capabilities.');
  assert(new Set(god.GOD_MODE_CAPABILITIES).size === 10, 'Capability IDs must be unique.');

  const quality = god.scoreContextQuality(
    [
      { rel: 'src/a.ts', startLine: 1, endLine: 4, kind: 'semantic' },
      { rel: 'src/b.ts', startLine: 5, endLine: 8, kind: 'lexical' },
    ],
    ['src/b.ts', 'src/missing.ts'],
  );
  assert(quality.precision === 0.5, 'Context precision is incorrect.');
  assert(quality.recall === 0.5, 'Context recall is incorrect.');
  assert(quality.reciprocalRank === 0.5, 'Context reciprocal rank is incorrect.');
  const contextSuite = god.summarizeContextEvals([
    { id: 'one', quality, durationMs: 2, tokensEstimated: 20 },
  ]);
  assert(contextSuite.averagePrecision === 0.5, 'Context evaluation aggregation is incorrect.');

  const metrics = god.summarizePredictionMetrics([10, 20, 100], {
    requested: 4,
    completed: 3,
    cacheHits: 1,
    stale: 1,
    accepted: 1,
    partial: 1,
    dismissed: 2,
  });
  assert(metrics.acceptanceRate === 0.5, 'Prediction acceptance metrics are incorrect.');
  assert(metrics.p95LatencyMs === 100, 'Prediction P95 is incorrect.');

  assert(god.canTransitionJob('running', 'paused'), 'Running jobs must be pausable.');
  assert(god.canTransitionJob('awaiting-approval', 'paused'), 'Approval-blocked jobs must be pausable.');
  assert(!god.canTransitionJob('completed', 'running'), 'Completed jobs must be terminal.');


  const autoLoop = load('apps/desktop/src/common/autoLoop.ts');
  assert(autoLoop.shouldContinueAutonomousPass({ cancelled: false, latestMutationVerified: false, completedPasses: 1, maxPasses: 5, convergenceAborted: false }), 'Unverified edits did not trigger another bounded Agent pass.');
  for (const terminal of [
    { cancelled: false, latestMutationVerified: true, completedPasses: 1, maxPasses: 5, convergenceAborted: false },
    { cancelled: true, latestMutationVerified: false, completedPasses: 1, maxPasses: 5, convergenceAborted: false },
    { cancelled: false, latestMutationVerified: false, completedPasses: 5, maxPasses: 5, convergenceAborted: false },
    { cancelled: false, latestMutationVerified: false, completedPasses: 1, maxPasses: 5, convergenceAborted: true },
  ]) assert(!autoLoop.shouldContinueAutonomousPass(terminal), 'Autonomous pass gate ignored a terminal condition.');

  for (const valid of ['http://localhost:3000', 'https://127.0.0.1:8443', 'http://[::1]:4173']) {
    assert(god.isSafePreviewUrl(valid), `Safe loopback preview rejected: ${valid}`);
  }
  for (const invalid of [
    'https://example.com',
    'file:///C:/secret',
    'http://user:pass@localhost:3000',
    'http://localhost:3000/callback?access_token=secret',
    'http://localhost:3000/#token=secret',
    'javascript:alert(1)',
  ]) {
    assert(!god.isSafePreviewUrl(invalid), `Unsafe preview URL accepted: ${invalid}`);
  }

  const plan = god.planAffectedChecks(
    'C:/work',
    ['src/a.ts', 'tests/a.test.ts'],
    { test: 'ignored renderer command', typecheck: 'ignored', lint: 'ignored', build: 'ignored' },
    100,
  );
  assert(plan.checks.length === 4, 'Affected check planning missed package scripts.');
  assert(plan.checks.every((check) => /^npm run [A-Za-z0-9:_-]+$/.test(check.command)), 'Verification plan accepted an arbitrary renderer command.');
  assert(god.hasFlakySignal('retry succeeded after timeout'), 'Flaky failure signals were missed.');

  assert(god.issueBranchName({ number: 7, title: 'Fix auth / redirect!' }) === 'axiom/issue-7-fix-auth-redirect', 'Issue branch naming is not deterministic.');
  const prBody = god.pullRequestBody(
    { owner: 'octo', repo: 'demo', number: 7 },
    { planId: 'p', startedAt: 1, endedAt: 2, passed: true, level: 'verified', results: [{ checkId: 'type', passed: true, exitCode: 0, durationMs: 1, summary: 'Typecheck passed', failures: [], flakySignal: false }] },
    'Implemented safely.',
  );
  assert(prBody.includes('Closes #7') && prBody.includes('[x] Typecheck passed'), 'PR evidence body is incomplete.');

  assert(god.validateWorkspaceBackendInput({ root: 'x', name: 'remote', backend: 'ssh', confirmation: true }).some((item) => item.includes('path')), 'SSH workspace accepted an implicit path.');
  assert(god.validateWorkspaceBackendInput({ root: 'x', name: 'remote', backend: 'ssh', workspacePath: '/work', confirmation: true }).some((item) => item.includes('host')), 'SSH workspace accepted a missing host.');

  assert(god.validateWasmModuleShape(8, []).length === 0, 'Minimal import-free WASM shape was rejected.');
  assert(god.validateWasmModuleShape(0, []).length > 0, 'Empty WASM was accepted.');
  assert(god.validateWasmModuleShape(5 * 1024 * 1024, []).length > 0, 'Oversized WASM was accepted.');
  assert(god.validateWasmModuleShape(8, ['env.fetch']).length > 0, 'Capability-bearing WASM import was accepted.');

  const wasmResources = load('apps/desktop/src/common/wasmResources.ts');
  const wasmHeader = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const inspectWasm = (tail, policy = { maxMemoryPages: 4, maxTableElements: 16 }) =>
    wasmResources.validateWasmBinaryResources(Uint8Array.from([...wasmHeader, ...tail]), policy);
  assert(inspectWasm([0x05, 0x04, 0x01, 0x01, 0x01, 0x04]).length === 0, 'Bounded WASM memory was rejected.');
  assert(inspectWasm([0x05, 0x03, 0x01, 0x00, 0x01]).some((item) => item.includes('declare a maximum')), 'WASM memory without a maximum was accepted.');
  assert(inspectWasm([0x05, 0x04, 0x01, 0x01, 0x05, 0x05]).some((item) => item.includes('minimum exceeds')), 'Excessive initial WASM memory was accepted.');
  assert(inspectWasm([0x05, 0x04, 0x01, 0x01, 0x01, 0x05]).some((item) => item.includes('maximum exceeds')), 'Excessive maximum WASM memory was accepted.');
  assert(inspectWasm([0x05, 0x04, 0x01, 0x03, 0x01, 0x02]).some((item) => item.includes('shared or 64-bit')), 'Shared WASM memory was accepted.');
  assert(inspectWasm([0x05, 0x04, 0x01, 0x05, 0x01, 0x02]).some((item) => item.includes('shared or 64-bit')), 'memory64 WASM memory was accepted.');
  assert(inspectWasm([0x05, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02]).some((item) => item.includes('more than one memory')), 'Multiple WASM memories were accepted.');
  assert(inspectWasm([0x05, 0x0a, 0x01, 0x01]).length > 0, 'Malformed WASM section bounds were accepted.');
  assert(inspectWasm([0x04, 0x05, 0x01, 0x70, 0x01, 0x01, 0x10]).length === 0, 'Bounded WASM table was rejected.');
  assert(inspectWasm([0x04, 0x04, 0x01, 0x70, 0x00, 0x01]).some((item) => item.includes('declare a maximum')), 'Unbounded WASM table was accepted.');

  assert(god.validateDeploymentTarget({ id: 'local', name: 'Local', provider: 'local-static', outputDirectory: 'dist' }).length === 0, 'Valid local deployment target was rejected.');

  const nextEdit = load('apps/desktop/src/common/nextEdit.ts');
  assert(
    !nextEdit.arbitrateInline({ enabled: true, prefix: 'object.', priority: 'intellisense' }),
    'Inline prediction did not yield to IntelliSense after a member trigger.',
  );
  const rename = nextEdit.diffLineToken('const oldName = 1;', 'const newName = 1;');
  assert(rename?.oldToken === 'oldName' && rename.newToken === 'newName', 'Single-token rename was not detected.');
  const edits = nextEdit.predictNextEdit('oldName\nvalue = oldName\noldNameExtra', rename, 1);
  assert(edits.length === 1 && edits[0].line === 2, 'Next-edit prediction did not retain whole-token semantics.');
  const editorPane = read('apps/desktop/src/renderer/src/editor/EditorPane.tsx');
  assert(editorPane.includes('predictNextEdit(model.getValue()'), 'Next-edit prediction is not wired into the editor.');

  const processEnvironment = load('apps/desktop/src/main/services/processEnvironment.ts');
  const childEnvironment = processEnvironment.buildChildProcessEnvironment(
    { ci: true, color: false },
    {
      PATH: 'C:/Windows/System32',
      TEMP: 'C:/Temp',
      GITHUB_TOKEN: 'must-not-inherit',
      NODE_OPTIONS: '--require attacker.js',
      ELECTRON_RUN_AS_NODE: '1',
    },
  );
  assert(
    childEnvironment.PATH === 'C:/Windows/System32' &&
      childEnvironment.CI === 'true' &&
      childEnvironment.GITHUB_TOKEN === undefined &&
      childEnvironment.NODE_OPTIONS === undefined &&
      childEnvironment.ELECTRON_RUN_AS_NODE === undefined,
    'Child process environment inherited a Main credential or runtime injection flag.',
  );

  assert(god.validateDeploymentTarget({ id: 'hook', name: 'Hook', provider: 'deploy-hook', secretRef: 'opaque', hookOrigin: 'https://example.com/path' }).length > 0, 'Non-origin deployment hook binding was accepted.');
}

async function validateContextService() {
  const service = load('apps/desktop/src/main/services/godModeContext.ts', {
    './contextBuilder': {
      buildContext: async (input) => ({
        text: `context:${input.query}`,
        tokensEstimated: 12,
        truncated: false,
        sources: [{ rel: 'src/auth.ts', startLine: 4, endLine: 9, kind: 'semantic' }],
      }),
    },
  });
  const report = await service.inspectContext('C:/work', {
    query: ' auth flow ',
    expectedPaths: ['src/auth.ts'],
  });
  assert(report.query === 'auth flow' && report.quality.recall === 1, 'Context service did not produce grounded cited evidence.');
  await reject(() => service.inspectContext('C:/work', { query: '   ' }), 'Blank context query was accepted.');
  await reject(
    () => service.evaluateContextSuite('C:/work', Array.from({ length: 26 }, (_, index) => ({ id: String(index), query: 'x', expectedPaths: ['x.ts'] }))),
    'Oversized context evaluation suite was accepted.',
  );
  await reject(
    () => service.evaluateContextSuite('C:/work', [
      { id: 'escape', query: 'x', expectedPaths: ['x.ts'], activePath: '../outside.ts' },
    ]),
    'Context evaluation accepted an active path outside the workspace.',
  );
  const controller = new AbortController();
  controller.abort();
  await reject(
    () => service.inspectContext('C:/work', { query: 'x' }, controller.signal),
    'Cancelled context request continued.',
  );
}

async function validateContextBuilderPaths(tempRoot) {
  const workspace = path.join(tempRoot, 'context-builder-root');
  const outside = path.join(tempRoot, 'context-builder-outside.ts');
  const safe = path.join(workspace, 'safe.ts');
  const canonicalEscape = path.join(workspace, 'canonical-escape.ts');
  await fsp.mkdir(workspace, { recursive: true });
  await Promise.all([
    fsp.writeFile(safe, 'export const safe = true;\n'),
    fsp.writeFile(outside, 'export const secret = true;\n'),
  ]);
  const service = load('apps/desktop/src/main/services/contextBuilder.ts', {
    './core': {
      coreRetrieve: async () => ({
        results: [
          { path: outside, startLine: 1, endLine: 1, score: 1 },
          { path: canonicalEscape, startLine: 1, endLine: 1, score: 0.9 },
          { path: safe, startLine: 1, endLine: 1, score: 0.8 },
        ],
      }),
      coreGraphDependencies: async () => ({ dependencies: [outside, canonicalEscape] }),
      coreProjectUnderstand: async () => ({}),
      coreSymbols: async () => [],
    },
    './pathAuthorization': {
      assertAuthorizedPath: async (candidate) =>
        path.resolve(candidate) === path.resolve(canonicalEscape)
          ? outside
          : path.resolve(candidate),
    },
  });
  const result = await service.buildContext({ root: workspace, query: 'safe', activePath: safe });
  assert(
    result.sources.some((item) => item.rel === 'safe.ts') &&
      result.sources.every((item) => item.path !== outside && item.path !== canonicalEscape) &&
      !result.text.includes('secret = true'),
    'Context builder read a lexical or canonical Core path escape.',
  );
  const controller = new AbortController();
  controller.abort();
  await reject(
    () => service.buildContext({ root: workspace, query: 'cancelled' }, controller.signal),
    'Cancelled context build continued into Core or filesystem work.',
  );
}

async function validateAiReadinessParity() {
  let usable = true;
  let observed = null;
  const service = load('apps/desktop/src/main/services/godMode.ts', {
    './godModeJobs': { listGodModeJobs: async () => [] },
    './settings': {
      readSettings: async () => ({
        'ai.provider': 'custom',
        'ai.custom.baseUrl': 'https://models.example.test/v1',
        'ai.custom.model': 'custom-model-v1',
        'ai.completion.enabled': true,
      }),
    },
    './secrets': {
      hasUsableAiCredential: async (provider, baseUrl) => {
        observed = { provider, baseUrl };
        return usable;
      },
    },
    './githubScm': { getGithubState: async () => ({ status: 'disconnected' }) },
    './systemGit': {
      currentCommit: async () => 'a'.repeat(40),
      getRepositoryInfo: async () => ({ remotes: [] }),
    },
  });
  const ready = await service.getGodModeSnapshot(1, 'C:/work', true);
  assert(
    observed?.provider === 'custom' &&
      observed?.baseUrl === 'https://models.example.test/v1' &&
      ready.capabilities.find((item) => item.id === 'predictive-editing')?.readiness === 'ready',
    'AI readiness did not use runtime Custom endpoint/keyless credential binding.',
  );
  usable = false;
  const unavailable = await service.getGodModeSnapshot(1, 'C:/work', true);
  assert(
    unavailable.capabilities.find((item) => item.id === 'predictive-editing')?.readiness ===
      'setup-required',
    'Unusable runtime AI binding was reported ready.',
  );
}

async function validatePredictiveService() {
  const service = load('apps/desktop/src/main/services/predictiveCompletion.ts');
  service.cancelAllPredictions();
  let firstAborted = false;
  const first = service.runPredictiveCompletion(
    1,
    { requestId: 'request-old-1', documentUri: 'file:///a.ts', documentVersion: 1, prefix: 'a', suffix: '', language: 'ts', trigger: 'typing' },
    'scope-a',
    (signal) => new Promise((resolve) => signal.addEventListener('abort', () => { firstAborted = true; resolve('old'); }, { once: true })),
  );
  const second = await service.runPredictiveCompletion(
    1,
    { requestId: 'request-new-2', documentUri: 'file:///a.ts', documentVersion: 2, prefix: 'ab', suffix: '', language: 'ts', trigger: 'typing' },
    'scope-a',
    async () => 'new',
  );
  const old = await first;
  assert(firstAborted && old.stale && old.text === '', 'Latest-document prediction did not suppress stale work.');
  assert(!second.stale && second.text === 'new', 'Current prediction was incorrectly suppressed.');

  let calls = 0;
  const base = { documentUri: 'file:///cache.ts', documentVersion: 1, prefix: 'cache', suffix: '', language: 'ts', trigger: 'typing' };
  await service.runPredictiveCompletion(2, { ...base, requestId: 'cache-req-01' }, 'provider-a', async () => { calls += 1; return 'one'; });
  await service.runPredictiveCompletion(2, { ...base, requestId: 'cache-req-02' }, 'provider-a', async () => { calls += 1; return 'two'; });
  await service.runPredictiveCompletion(2, { ...base, requestId: 'cache-req-03' }, 'provider-b', async () => { calls += 1; return 'three'; });
  assert(calls === 2, 'Prediction cache was not isolated by provider/credential scope.');
  service.recordPredictionFeedback(2, { requestId: 'cache-req-02', kind: 'accepted', acceptedCharacters: 3, at: Date.now() });
  service.recordPredictionFeedback(99, { requestId: 'cache-req-03', kind: 'accepted', acceptedCharacters: 3, at: Date.now() });
  assert(service.predictionMetrics().accepted >= 1, 'Owned prediction feedback was not recorded.');
  await reject(
    () => service.runPredictiveCompletion(
      2,
      { ...base, requestId: 'oversized-uri-1', documentUri: `file:///${'x'.repeat(5_000)}` },
      'provider-a',
      async () => 'never',
    ),
    'Predictive completion accepted an unbounded document URI key.',
  );
  const bounded = Array.from({ length: 8 }, (_, index) =>
    service.runPredictiveCompletion(
      3,
      {
        ...base,
        requestId: `bounded-${String(index).padStart(2, '0')}`,
        documentUri: `file:///bounded-${index}.ts`,
        prefix: `bounded-prefix-${index}`,
      },
      'provider-a',
      (signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve('cancelled'), { once: true }),
        ),
    ),
  );
  await reject(
    () => service.runPredictiveCompletion(
      3,
      { ...base, requestId: 'bounded-09', documentUri: 'file:///bounded-9.ts' },
      'provider-a',
      async () => 'never',
    ),
    'Predictive completion exceeded its per-owner active-request bound.',
  );
  service.cancelPredictionsForOwner(3);
  const boundedResults = await Promise.all(bounded);
  assert(boundedResults.every((item) => item.stale), 'Bounded predictive requests did not cancel cleanly.');
  service.cancelAllPredictions();
}

async function validateWorkspaceTrustRevocation(tempRoot) {
  const userData = path.join(tempRoot, 'trust-user-data');
  const workspace = path.join(tempRoot, 'trust-workspace');
  await fsp.mkdir(workspace, { recursive: true });
  const service = load('apps/desktop/src/main/services/workspaceTrust.ts', {
    electron: { app: { getPath: () => userData } },
    './pathAuthorization': {
      assertAuthorizedWorkspaceRoot: async (rootValue) => path.resolve(rootValue),
      assertAuthorizedPath: async (pathValue) => path.resolve(pathValue),
    },
  });

  const olderTrustWrite = service.setWorkspaceTrust(workspace, true);
  service.markWorkspaceTrustRevoked(workspace);
  const staleResult = await olderTrustWrite;
  assert(!staleResult.trusted, 'An older in-flight trust write cleared a newer revocation tombstone.');
  await reject(
    () => service.assertWorkspaceTrusted(workspace),
    'A newer trust revocation did not immediately remain authoritative.',
  );

  const retrusted = await service.setWorkspaceTrust(workspace, true);
  assert(retrusted.trusted, 'A later explicit successful trust write did not clear the tombstone.');
  assert(
    path.resolve(await service.assertWorkspaceTrusted(workspace)) === path.resolve(workspace),
    'Explicit retrust did not restore the canonical trusted root.',
  );

  service.markWorkspaceTrustRevoked(workspace);
  const revoked = await service.setWorkspaceTrust(workspace, false);
  assert(!revoked.trusted, 'Persisted revocation reported a trusted workspace.');
  await reject(
    () => service.assertWorkspaceTrusted(workspace),
    'Persisted revocation did not remain fail-closed.',
  );
}

async function validateVerificationService(tempRoot) {
  const workspace = path.join(tempRoot, 'verification-workspace');
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'src', 'a.ts'), 'export const value = 1;\n');
  await fsp.writeFile(path.join(workspace, '.env.local'), 'IGNORED_SECRET=must-not-enter-snapshot\n');
  const packageText = JSON.stringify({
    name: 'verification-smoke',
    private: true,
    scripts: {
      pretypecheck: 'node -e "process.exit(9)"',
      typecheck: 'node -e "process.exit(require(\'node:fs\').existsSync(\'.env.local\') ? 1 : 0)"',
      posttypecheck: 'node -e "process.exit(9)"',
    },
  });
  await fsp.writeFile(path.join(workspace, 'package.json'), packageText);
  let commit = 'a'.repeat(40);
  const status = {
    branch: 'main',
    staged: [],
    unstaged: [{ type: 'modified', path: 'src/a.ts' }],
    conflicts: [],
  };
  let enumeratedSnapshotFiles = [];
  let includeSensitiveSnapshotPath = false;
  const service = load('apps/desktop/src/main/services/verification.ts', {
    electron: { app: { getPath: () => tempRoot } },
    './git': { getStatus: async () => status },
    './systemGit': {
      currentCommit: async () => commit,
      listVerificationSnapshotFiles: async () => {
        enumeratedSnapshotFiles = [
          'package.json',
          'src/a.ts',
          ...(includeSensitiveSnapshotPath ? ['.env.local'] : []),
        ];
        return enumeratedSnapshotFiles;
      },
    },
    './workspaceTrust': { assertWorkspaceTrusted: async (root) => path.resolve(root) },
    './processTree': { terminateProcessTree: async () => undefined },
  });
  const owner = Object.assign(new EventEmitter(), { id: 7 });
  const plan = await service.createVerificationPlan(owner, workspace, [
    '../escape.ts',
    'src/a.ts',
    path.resolve(workspace, 'absolute.ts'),
  ]);
  assert(plan.changedFiles.length === 1 && plan.changedFiles[0] === 'src/a.ts', 'Verification accepted traversal or absolute renderer paths.');
  assert(plan.checks.length === 1 && plan.checks[0].command === 'npm run typecheck', 'Verification did not generate its command from package scripts.');
  await reject(() => service.runVerificationPlan(owner, plan.id, [plan.checks[0].id], false), 'Verification ran without explicit confirmation.');
  includeSensitiveSnapshotPath = true;
  await reject(
    () => service.prepareVerificationExecution(owner, plan.id, [plan.checks[0].id], true),
    'Verification authorized an incomplete snapshot containing a non-ignored sensitive path.',
  );
  includeSensitiveSnapshotPath = false;
  const snapshotDirectoriesBefore = new Set(
    (await fsp.readdir(tempRoot)).filter((name) => name.startsWith('axiom-verification-')),
  );
  const approval = await service.prepareVerificationExecution(
    owner,
    plan.id,
    [plan.checks[0].id],
    true,
  );
  const swappedPackage = JSON.parse(packageText);
  swappedPackage.scripts.typecheck = 'node -e "process.exit(7)"';
  let result;
  try {
    await fsp.writeFile(path.join(workspace, 'package.json'), JSON.stringify(swappedPackage));
    result = await service.executePreparedVerification(owner, approval);
  } finally {
    await fsp.writeFile(path.join(workspace, 'package.json'), packageText);
  }
  assert(result.passed && result.level === 'verified', 'Generated immutable verification script did not execute successfully.');
  assert(
    /^[0-9a-f]{64}$/.test(result.snapshotSha256) &&
      result.snapshotFileCount === 2 &&
      result.snapshotBytes > 0 &&
      /^[0-9a-f]{64}$/.test(result.sourceFingerprint) &&
      result.cleanCommitSha === null,
    'Verification omitted immutable snapshot identity or incorrectly claimed a dirty clean commit.',
  );
  assert(
    !enumeratedSnapshotFiles.includes('.env.local'),
    'Ignored sensitive path entered the Git snapshot enumeration.',
  );
  const snapshotDirectoriesAfter = new Set(
    (await fsp.readdir(tempRoot)).filter((name) => name.startsWith('axiom-verification-')),
  );
  assert(
    JSON.stringify([...snapshotDirectoriesAfter].sort()) ===
      JSON.stringify([...snapshotDirectoriesBefore].sort()),
    'Prepared verification snapshot was not cleaned after execution.',
  );
  assert((await service.requireVerifiedPlan(7, plan.id, workspace)).passed, 'Fresh owned verification could not be retained.');
  await reject(() => service.requireVerifiedPlan(8, plan.id, workspace), 'Another renderer reused retained verification.');
  await fsp.writeFile(path.join(workspace, 'src', 'a.ts'), 'export const value = 2;\n');
  await reject(() => service.requireVerifiedPlan(7, plan.id, workspace), 'Changed workspace content reused stale verification.');

  const secondPlan = await service.createVerificationPlan(owner, workspace, ['src/a.ts']);
  const secondResult = await service.runVerificationPlan(owner, secondPlan.id, [secondPlan.checks[0].id], true);
  assert(secondResult.passed, 'Second verification run failed unexpectedly.');
  commit = 'b'.repeat(40);
  await reject(() => service.requireVerifiedPlan(7, secondPlan.id, workspace), 'A clean HEAD change reused stale verification.');

  const revokedPlan = await service.createVerificationPlan(owner, workspace, ['src/a.ts']);
  const revokedResult = await service.runVerificationPlan(
    owner,
    revokedPlan.id,
    [revokedPlan.checks[0].id],
    true,
  );
  assert(revokedResult.passed, 'Revocation fixture verification failed unexpectedly.');
  await service.cancelVerificationsForWorkspace(workspace);
  await reject(
    () => service.requireVerifiedPlan(7, revokedPlan.id, workspace),
    'Workspace revocation retained verification authority.',
  );
}


async function validateDebugEvidence() {
  const service = load('apps/desktop/src/main/services/debugEvidence.ts', {
    './dap': {
      debugStackTrace: async () => [
        { id: 1, name: 'handler', path: 'C:/work/src/a.ts', line: 12, column: 3 },
        { id: 2, name: 'library', path: 'C:/outside/library.ts', line: 4, column: 1 },
      ],
      debugScopes: async () => [{ name: 'Locals', variablesReference: 9, expensive: false }],
      debugVariables: async () => [
        { name: 'api_token', value: 'github_pat_abcdefghijklmnopqrstuvwxyz', type: 'string', variablesReference: 0 },
        { name: 'url', value: 'https://user:password@example.com/path', type: 'string', variablesReference: 0 },
        { name: 'count', value: '3', type: 'number', variablesReference: 0 },
      ],
    },
  });
  const snapshot = await service.captureDebugEvidence('C:/work', 5);
  assert(snapshot.frames[0].workspacePath === 'src/a.ts', 'Debugger path was not made workspace-relative.');
  assert(snapshot.frames[1].workspacePath === null, 'External debugger path leaked.');
  assert(snapshot.redactedValues === 4, 'Debugger secret redaction count is incorrect.');
  assert(!JSON.stringify(snapshot).includes('github_pat_') && !JSON.stringify(snapshot).includes('password@'), 'Debugger evidence leaked a secret-shaped value.');
  await reject(() => service.captureDebugEvidence('C:/work', -1), 'Invalid debugger thread was accepted.');
}

async function validateDurableJobs(tempRoot) {
  const service = load('apps/desktop/src/main/services/godModeJobs.ts', {
    electron: { app: { getPath: () => tempRoot } },
  });
  const created = await service.createAutonomousJob(1, 'C:/work', {
    goal: 'Implement and verify the requested behavior.',
    maxIterations: 4,
  });
  assert(created.status === 'queued' && created.resumeRunId === null, 'Fresh durable job state is invalid.');
  const running = await service.claimAndStartJob(1, 'C:/work', created.id);
  assert(running.status === 'running', 'Queued durable job was not claimable.');
  await service.recoverInterruptedGodModeJobs();
  const paused = (await service.listGodModeJobs('C:/work')).find((job) => job.id === created.id);
  assert(paused?.status === 'paused' && paused.ownerWindowId === null, 'Interrupted job did not recover to an unleased paused state.');
  const successor = await service.controlGodModeJob(2, 'C:/work', { id: created.id, action: 'resume' });

async function validateIssueToPrService() {
  const ref = { owner: 'octocat', repo: 'demo', number: 42 };
  const canonical = 'https://github.com/octocat/demo';
  const matchingRemote = { name: 'origin', fetchUrl: canonical, pushUrl: canonical, github: true };
  let repositoryRemotes = [matchingRemote];
  let status = {
    branch: 'axiom/issue-42-fix-auth',
    staged: [],
    unstaged: [],
    conflicts: [],
    remotes: [matchingRemote],
    upstream: null,
  };
  let branchCreated = '';
  let pushedExpected = '';
  let postedBody = null;
  let pullPayload = {
    number: 9,
    html_url: 'https://github.com/octocat/demo/pull/9',
    draft: false,
  };
  const service = load('apps/desktop/src/main/services/githubIssuePr.ts', {
    './git': {
      getStatus: async () => status,
      commit: async () => 'a'.repeat(40),
    },
    './systemGit': {
      getRepositoryInfo: async () => ({ remotes: repositoryRemotes }),
      createBranch: async (_root, branch) => { branchCreated = branch; return { outcome: 'success' }; },
      pushRepository: async (_root, _sink, expected) => { pushedExpected = expected; return { outcome: 'success' }; },
      commitAndPush: async () => ({ outcome: 'success' }),
    },
    './verification': {
      requireVerifiedPlan: async (ownerId, planId) => {
        assert(ownerId === 5 && planId === 'verified-plan', 'PR used the wrong retained verification owner/id.');
        return {
          planId,
          startedAt: 1,
          endedAt: 2,
          passed: true,
          level: 'verified',
          results: [{ checkId: 'typecheck', passed: true, exitCode: 0, durationMs: 1, summary: 'Typecheck passed', failures: [], flakySignal: false }],
        };
      },
    },
    './githubApi': {
      githubApiRequest: async (_ownerId, apiPath, method, body) => {
        if (method === 'GET') {
          return {
            status: 200,
            ok: true,
            payload: {
              number: 42,
              title: 'Fix auth',
              body: '- [ ] Redirect safely\n- [x] Add tests',
              html_url: 'https://github.com/octocat/demo/issues/42',
              state: 'open',
              labels: [{ name: 'bug' }],
              user: { login: 'octocat' },
              updated_at: '2025-01-01T00:00:00Z',
            },
          };
        }
        assert(apiPath === '/repos/octocat/demo/pulls', 'PR API path escaped the expected repository.');
        postedBody = body;
        return { status: 201, ok: true, payload: pullPayload };
      },
    },
  });

  const plan = await service.planGithubIssue(5, 'C:/work', ref);
  assert(plan.acceptanceCriteria.length === 2 && plan.branch === 'axiom/issue-42-fix-auth', 'Issue metadata did not produce a bounded work plan.');
  await reject(() => service.startGithubIssue(5, 'C:/work', ref, false), 'Issue branch was created without confirmation.');
  await service.startGithubIssue(5, 'C:/work', ref, true);
  assert(branchCreated === plan.branch, 'Confirmed issue branch was not created through system Git.');

  const input = {
    root: 'C:/work',
    issue: ref,
    title: 'Fix auth',
    summary: 'Implemented safely.',
    head: plan.branch,
    base: 'main',
    draft: false,
    verificationPlanId: 'verified-plan',
    confirmation: true,
  };
  const approval = await service.preparePullRequestApproval(5, 'C:/work', input);
  const result = await service.createVerifiedPullRequest({ id: 5 }, 'C:/work', input, approval);
  assert(result.number === 9 && pushedExpected === canonical, 'Verified PR did not bind its push to the exact issue repository.');
  assert(postedBody.body.includes('[x] Typecheck passed'), 'PR body omitted retained verification evidence.');
  await reject(() => service.createVerifiedPullRequest({ id: 5 }, 'C:/work', { ...input, confirmation: false }), 'PR mutation ran without confirmation.');
  await reject(
    () => service.createVerifiedPullRequest({ id: 5 }, 'C:/work', { ...input, title: 'Changed after approval' }, approval),
    'PR input drift after native approval was accepted.',
  );

  status = {
    ...status,
    remotes: [{ name: 'origin', fetchUrl: 'https://github.com/attacker/demo', pushUrl: 'https://github.com/attacker/demo', github: true }],
  };
  await reject(() => service.createVerifiedPullRequest({ id: 5 }, 'C:/work', input, approval), 'PR push accepted a different current-branch destination.');
  status = { ...status, remotes: [matchingRemote] };
  pullPayload = { ...pullPayload, html_url: 'https://github.com/octocat/demo/pull/9/files' };
  await reject(() => service.createVerifiedPullRequest({ id: 5 }, 'C:/work', input, approval), 'PR accepted a non-exact returned GitHub URL.');

  repositoryRemotes = [{ name: 'origin', fetchUrl: canonical, pushUrl: 'https://github.com/attacker/demo', github: true }];
  await reject(() => service.loadGithubIssue(5, 'C:/work', ref), 'Issue load accepted mismatched fetch and push repositories.');
}

  await validateIssueToPrService();

  assert(successor.id !== created.id && successor.status === 'queued' && successor.resumeRunId === created.id, 'Resume did not create a queued successor bound to the prior Agent journal.');
  const old = (await service.listGodModeJobs('C:/work')).find((job) => job.id === created.id);
  assert(old?.resumable === false, 'Resumed source job remained replayable more than once.');
  await service.claimAndStartJob(2, 'C:/work', successor.id);
  await service.recordGodModeAgentEvent({
    id: successor.id,
    root: 'C:/work',
    at: Date.now(),
    kind: 'tool',
    step: 1,
    tool: 'run_command',
    observation: '[VERIFICATION] Tests passed.\nExit code 0.',
    activity: { status: 'succeeded' },
  }, 2);
  await service.recordGodModeAgentEvent({
    id: successor.id,
    root: 'C:/work',
    at: Date.now() + 1,
    kind: 'final',
    step: 2,
    text: 'Implemented and verified.',
    outcome: 'completed',
  }, 2);
  const completed = (await service.listGodModeJobs('C:/work')).find((job) => job.id === successor.id);
  assert(completed?.status === 'completed' && completed.evidence.some((item) => item.kind === 'test' && item.passed === true), 'Durable job did not retain successful verification evidence.');
}

async function validateExtensionAdversaries(tempRoot) {
  const validBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const validPath = path.join(tempRoot, 'valid.wasm');
  await fsp.writeFile(validPath, validBytes);
  const validHash = crypto.createHash('sha256').update(validBytes).digest('hex');
  const publisherKeys = crypto.generateKeyPairSync('ed25519');
  const publisherKey = publisherKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signature = crypto
    .sign(null, Buffer.from(validHash, 'utf8'), publisherKeys.privateKey)
    .toString('base64');


  class SilentWorker extends EventEmitter {
    static terminations = 0;
    terminate() {
      SilentWorker.terminations += 1;
      return Promise.resolve(1);
    }
  }

  class SuccessWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() =>
        this.emit('message', {
          ok: true,
          sha256: validHash,
          imports: [],
          exports: [],
          activated: true,
          error: null,
        }),
      );
    }
    terminate() {
      return Promise.resolve(0);
    }
  }

  const makeService = ({
    expectedHash = validHash,
    imports = [],
    modulePath = validPath,
    timeoutMs = 20,
    signatureValue,
    publisherKeyValue,
    workerClass = SilentWorker,
  } = {}) => {
    const manifest = {
      id: 'example.wasm',
      name: 'Example',
      enabled: false,
      permissions: {},
      runtime: {
        entry: 'valid.wasm',
        sha256: expectedHash,
        memoryLimitMb: 8,
        timeoutMs,
        ...(signatureValue ? { signature: signatureValue } : {}),
        ...(publisherKeyValue ? { publisherKey: publisherKeyValue } : {}),
      },
    };
    const state = [];
    const service = load('apps/desktop/src/main/services/extensionSandbox.ts', {
      'node:worker_threads': { Worker: workerClass },
      '../../common/extensionManifest': { summarizePermissions: () => 'no special permissions' },
      './extensions': {
        listExtensions: async () => [manifest],
        resolveExtensionWasm: async () => ({ manifest, modulePath }),
        setSandboxExtensionEnabledState: async (_id, enabled) => { state.push(enabled); return [manifest]; },
      },
      '../wasmRuntime': {
        getWasmRuntime: () => ({
          compile: async () => ({}),
          Module: { imports: () => imports.map((name) => ({ module: name.split('.')[0], name: name.split('.')[1] })), exports: () => [] },
        }),
      },
    });
    return { service, state };
  };

  await reject(
    () => makeService({ expectedHash: '0'.repeat(64) }).service.enableSandboxExtension(Object.assign(new EventEmitter(), { id: 1 }), 'C:/work', 'example.wasm', true, true),
    'WASM hash mismatch was accepted.',
  );
  await reject(
    () => makeService().service.enableSandboxExtension(Object.assign(new EventEmitter(), { id: 1 }), 'C:/work', 'example.wasm', true, false),
    'Unsigned WASM ran without explicit approval.',
  );
  await reject(
    () =>
      makeService({
        signatureValue: signature,
        publisherKeyValue: publisherKey,
        workerClass: SuccessWorker,
      }).service.enableSandboxExtension(
        Object.assign(new EventEmitter(), { id: 1 }),
        'C:/work',
        'example.wasm',
        true,
        false,
      ),
    'Self-declared signed WASM ran without untrusted-publisher approval.',
  );
  await reject(
    () => makeService({ imports: ['env.fetch'] }).service.enableSandboxExtension(Object.assign(new EventEmitter(), { id: 1 }), 'C:/work', 'example.wasm', true, true),
    'WASM import capability was accepted.',
  );

  const oversizedPath = path.join(tempRoot, 'oversized.wasm');
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0);
  await fsp.writeFile(oversizedPath, oversized);
  const oversizedHash = crypto.createHash('sha256').update(oversized).digest('hex');
  await reject(
    () => makeService({ expectedHash: oversizedHash, modulePath: oversizedPath }).service.enableSandboxExtension(Object.assign(new EventEmitter(), { id: 1 }), 'C:/work', 'example.wasm', true, true),
    'Oversized WASM passed preflight.',
  );

  const timed = makeService({ timeoutMs: 15 });
  const timedOwner = Object.assign(new EventEmitter(), { id: 1 });
  await reject(
    () => timed.service.enableSandboxExtension(timedOwner, 'C:/work', 'example.wasm', true, true),
    'Non-terminating WASM worker exceeded its quota without rejection.',
  );
  assert(SilentWorker.terminations > 0 && timed.state.includes(false), 'Timed-out WASM worker was not terminated and disabled.');
  assert(timedOwner.listenerCount('destroyed') === 0, 'Timed-out WASM worker retained its owner lifecycle listener.');

  const extensionSource = read('apps/desktop/src/main/services/extensions.ts');
  assert(/realpath\(resolve\(extensionDir, entry\.manifest\.runtime\.entry\)\)/.test(extensionSource), 'WASM realpath containment is missing.');
  assert(extensionSource.includes('Extension WASM module escapes its extension directory.'), 'WASM realpath escape is not rejected.');
  assert(extensionSource.includes('Legacy JavaScript extension entry points remain disabled.'), 'Legacy executable JavaScript is not fail-closed.');
  const workerSource = read('apps/desktop/src/main/extensionSandboxWorker.ts');
  assert(!workerSource.includes('ELECTRON_RUN_AS_NODE'), 'WASM worker added an Electron-as-Node consumer.');
  assert(workerSource.includes('WASM imports are denied'), 'WASM worker does not deny imports.');
  assert(workerSource.includes('WASM integrity verification failed'), 'WASM worker does not independently recheck its hash.');
  assert(workerSource.includes('validateWasmBinaryResources'), 'WASM worker does not inspect memory/table limits before compilation.');
  assert(read('apps/desktop/src/main/services/extensionSandbox.ts').includes('validateWasmBinaryResources'), 'WASM Main preflight does not inspect memory/table limits.');
}

function validateStructuralBoundaries() {
  const ipc = read('apps/desktop/src/common/ipc.ts');
  const mainIpc = read('apps/desktop/src/main/ipc.ts');
  const preload = read('apps/desktop/src/preload/index.ts');
  const env = read('apps/desktop/src/renderer/src/env.d.ts');
  const ui = read('apps/desktop/src/renderer/src/workbench/GodModeView.tsx');
  const index = read('apps/desktop/src/main/index.ts');

  for (const channel of [
    'godModeContextInspect', 'godModeContextEvaluate', 'godModeJobCreate', 'godModePreviewOpen',
    'godModeVerificationRun', 'godModeDebugEvidence', 'godModeIssueCreatePr', 'godModeWorkspaceRun',
    'godModeExtensionEnable', 'godModeCollaborationShare', 'godModeDeploymentExecute',
  ]) {
    assert(ipc.includes(`${channel}:`), `IPC allow-list is missing ${channel}.`);
    assert(mainIpc.includes(`IPC.${channel}`), `Main handler is missing ${channel}.`);
    assert(preload.includes(`IPC.${channel}`), `Preload bridge is missing ${channel}.`);
  }
  assert(env.includes('captureEvidence: (threadId: number)'), 'Renderer debugger evidence type is missing.');
  assert(!preload.includes('resolveDeploymentHook'), 'Renderer can resolve an encrypted deploy hook value.');

  // Root-bound preview control: every operation must verify the canonical trusted root.
  includes('apps/desktop/src/main/services/preview.ts', 'function previewForRoot(', 'Preview root-binding helper');
  includes('apps/desktop/src/main/services/preview.ts', 'The open preview belongs to a different workspace.', 'Preview cross-root rejection');
  assert(
    /getPreview\(\s*ownerId: number,\s*root: string,/.test(read('apps/desktop/src/main/services/preview.ts')) &&
      /selectPreviewElement\(\s*ownerId: number,\s*root: string,/.test(read('apps/desktop/src/main/services/preview.ts')),
    'Preview service operations are not root-scoped.',
  );
  assert(
    mainIpc.includes('previewService.getPreview(event.sender.id, await trustedWorkspaceRoot(rootValue))') &&
      mainIpc.includes('previewService.selectPreviewElement(event.sender.id, await trustedWorkspaceRoot(rootValue))') &&
      mainIpc.includes('previewService.closePreview(event.sender.id, await trustedWorkspaceRoot(rootValue))'),
    'Preview Main handlers are not bound to the canonical trusted root.',
  );
  assert(
    preload.includes('get: (root: string): Promise<PreviewSnapshot | null>') &&
      preload.includes('refresh: (root: string): Promise<PreviewSnapshot>') &&
      preload.includes('selectElement: (root: string): Promise<PreviewSnapshot>'),
    'Preview preload bridge is not root-scoped.',
  );
  assert(
    env.includes('get: (root: string) => Promise<PreviewSnapshot | null>'),
    'Preview renderer types are not root-scoped.',
  );
  assert(
    ui.includes('.get(rootPath)') &&
      ui.includes('.refresh(rootPath!)') &&
      ui.includes('.capture(rootPath!)') &&
      ui.includes('.selectElement(rootPath!)') &&
      ui.includes('.close(rootPath!)'),
    'God Mode preview UI does not pass the canonical root to every operation.',
  );

  // Exact workspace-target probing: probe the configured distro/host/user/container/path.
  includes('apps/desktop/src/main/services/isolatedWorkspaces.ts', 'export async function probeWorkspaceTarget(', 'Exact workspace target probe');
  assert(
    mainIpc.includes('isolatedWorkspaceService.probeWorkspaceTarget('),
    'Workspace probe Main handler does not probe the exact configured target.',
  );
  assert(
    preload.includes('probe: (input: WorkspaceProbeInput): Promise<RemoteProbeResult>'),
    'Workspace probe bridge is not exact-target typed.',
  );
  assert(
    env.includes('probe: (input: WorkspaceProbeInput) => Promise<RemoteProbeResult>'),
    'Workspace probe renderer type is not exact-target typed.',
  );

  // Durable-job launch acknowledgement + bounded iteration binding.
  const commandBuses = read('apps/desktop/src/renderer/src/commands/commandBuses.ts');
  assert(
    commandBuses.includes('AiDockCommandAcknowledgement') &&
      commandBuses.includes('AI_COMMAND_ACK_TIMEOUT_MS') &&
      commandBuses.includes('acknowledge: settle'),
    'AI dock commands are not acknowledged with a bounded timeout.',
  );
  assert(
    mainIpc.includes('The God Mode iteration budget is not bound to this claimed job.') &&
      mainIpc.includes("job.status === 'running'"),
    'Durable iteration budget is not rebound to an owner/root-bound claimed running job.',
  );
  assert(
    read('apps/desktop/src/main/services/agent.ts').includes(
      'createAutoLoop(params.task, params.maxIterations ? { maxIterations: params.maxIterations } : {})',
    ),
    'Durable maxIterations does not reach the bounded autonomous loop.',
  );

  // Verification can be stopped independently of the single-action admission gate.
  assert(
    ui.includes('cancelActiveVerification') && ui.includes('verification.cancel('),
    'Verification cannot be stopped independently from the God Mode UI.',
  );

  // Security evidence is derived from the selected workspace, not hard-coded fixtures.
  const security = read('apps/desktop/src/renderer/src/workbench/SecurityView.tsx');
  assert(
    security.includes('discoverEgressEndpoints(') && security.includes('window.axiom.fs.search('),
    'Security egress review is not derived from workspace files.',
  );
  assert(
    security.includes('parseRlsSchema(') &&
      !security.includes("host: 'api.openai.com'") &&
      !security.includes('bmdprpuehhalabhtndmf'),
    'Security review still relies on hard-coded egress/RLS fixtures.',
  );
  assert(
    security.includes("from './icons'") && !/\uD83D\uDE80|\uD83D\uDD10|\uD83C\uDF10|\u2764/.test(security),
    'Security view still renders raw emoji instead of themed AXIOM icons.',
  );

  includes('apps/desktop/src/main/services/preview.ts', 'partition = `axiom-preview-${id}`', 'Preview ephemeral session');
  includes('apps/desktop/src/main/services/preview.ts', 'sandbox: true', 'Preview sandbox');
  includes('apps/desktop/src/main/services/preview.ts', 'nodeIntegration: false', 'Preview Node isolation');
  includes('apps/desktop/src/main/services/preview.ts', 'setPermissionRequestHandler', 'Preview permission denial');
  includes('apps/desktop/src/main/services/preview.ts', 'isSafePreviewUrl(input.url, false)', 'Preview loopback gate');
  includes('apps/desktop/src/main/services/preview.ts', "onBeforeRequest({ urls: ['<all_urls>'] }", 'Preview network egress filter');
  includes('apps/desktop/src/main/services/preview.ts', 'expectedProtocols.has(requested.protocol)', 'Preview exact endpoint scheme gate');
  includes('apps/desktop/src/main/services/preview.ts', 'setDisplayMediaRequestHandler', 'Preview display capture denial');
  includes('apps/desktop/src/main/services/preview.ts', 'await closeRecord(record)', 'Preview load failure cleanup');
  assert(index.includes('isManagedPreviewWebContents(contents)'), 'Global navigation does not preserve managed preview policy.');
  for (const cleanup of ['closeAllPreviews()', 'cancelAllVerifications()', 'cancelAllIsolatedCommands()', 'terminateAllExtensionSandboxes()', 'stopAllDeployments()', 'cancelAllPredictions()']) {
    assert(index.includes(cleanup), `Shutdown is missing ${cleanup}.`);
  }
  assert(index.includes('recoverInterruptedGodModeJobs()'), 'Durable jobs are not recovered at startup.');

  const verification = read('apps/desktop/src/main/services/verification.ts');
  assert(verification.includes('stored.scripts.get(check.id)'), 'Verification can execute a renderer-authored command.');
  assert(verification.includes('workspaceFingerprint') && verification.includes('Workspace files changed after verification'), 'Verification evidence is not content-bound.');
  assert(verification.includes('buildChildProcessEnvironment({ ci: true, color: false })'), 'Verification environment is not positively allowlisted.');

  const issue = read('apps/desktop/src/main/services/githubIssuePr.ts');
  assert(issue.includes('requireVerifiedPlan'), 'PR creation is not bound to retained verification.');
  assert(issue.includes('createBranch') && issue.includes('status.unstaged.length') && issue.includes('status.conflicts.length'), 'Issue/PR workflow does not enforce branch and worktree safety.');
  const systemGit = read('apps/desktop/src/main/services/systemGit.ts');
  assert(systemGit.includes("assertClean(git, 'creating a branch')"), 'Issue branch creation does not require a clean worktree.');
  assert(systemGit.includes('assertExpectedGithubPush(remote.push, expectedGithubRepository)'), 'Issue PR push is not revalidated inside system Git.');
  const githubApi = read('apps/desktop/src/main/services/githubApi.ts');
  assert(githubApi.includes("const GITHUB_API_ORIGIN = 'https://api.github.com'"), 'GitHub API origin is not fixed.');
  assert(!githubApi.includes('client_secret'), 'God Mode GitHub API supports a client secret.');

  const isolated = read('apps/desktop/src/main/services/isolatedWorkspaces.ts');
  assert(isolated.includes('terminateProcessTree') && isolated.includes('buildChildProcessEnvironment'), 'Isolated workspace commands lack process/environment cleanup.');
  assert(isolated.includes('BatchMode=yes') && isolated.includes('StrictHostKeyChecking=yes'), 'SSH workspace execution can prompt or bypass known-host verification.');
  assert(isolated.includes("commandForProfile(profile, 'pwd')"), 'Remote workspace target/path is not probed before readiness.');
  assert(isolated.includes('.filter((profile) => rootKey(profile.sourceRoot) === key)'), 'Isolated profiles are not source-root scoped.');
  assert(isolated.includes('finally {') && isolated.includes('running.delete(options.profileId)'), 'Failed isolated commands can strand a running lease.');
  assert(isolated.includes('managed') && isolated.includes('app.getPath'), 'Managed clone deletion lacks app-data boundary binding.');
  assert(
    mainIpc.includes('adapterCommand.length > 1_000') &&
      mainIpc.includes('adapterArgs.length > 32') &&
      mainIpc.includes('argument.length > 256') &&
      mainIpc.includes('launchArgsJson.length > 8_000') &&
      mainIpc.includes('Adapter arguments: ${JSON.stringify(config.adapterArgs)}'),
    'Debugger native approval can hide or truncate adapter/launch arguments.',
  );
  assert(
    mainIpc.includes('detail.length > 12_000') &&
      !mainIpc.includes("sanitizeText(detail, 2_000)"),
    'Native God Mode approval silently truncates exact action detail.',
  );
  for (const drain of [
    'closePreviewsForWorkspace(canonicalRoot)',
    'cancelVerificationsForWorkspace(canonicalRoot)',
    'cancelIsolatedCommandsForWorkspace(canonicalRoot)',
    'terminateExtensionSandboxesForWorkspace(canonicalRoot)',
    'stopDeploymentsForWorkspace(canonicalRoot)',
    'cancelContextBuildsForWorkspace(canonicalRoot)',
  ]) {
    assert(mainIpc.includes(drain), `Trust revocation is missing ${drain}.`);
  }
  const contextBuilder = read('apps/desktop/src/main/services/contextBuilder.ts');
  assert(
    contextBuilder.includes('resolveWithinWorkspaceRoot(root, candidate)') &&
      contextBuilder.includes('await assertAuthorizedPath(lexical)') &&
      contextBuilder.includes('resolveWithinWorkspaceRoot(root, canonical)'),
    'Core-returned context paths are not lexically and canonically re-authorized.',
  );
  assert(
    contextBuilder.includes('signal?.throwIfAborted()') &&
      read('apps/desktop/src/main/services/godModeContext.ts').includes('signal,'),
    'Context cancellation does not propagate into internal Core/filesystem awaits.',
  );
  const rustGraph = read('crates/axiom-core/src/graph.rs');
  assert(
    rustGraph.includes('contained_file(root, candidate)') &&
      rustGraph.includes('canonicalize_root(root)') &&
      rustGraph.includes('walk_no_links'),
    'Rust dependency graph can resolve an import outside the canonical root.',
  );
  const godModeService = read('apps/desktop/src/main/services/godMode.ts');
  assert(
    godModeService.includes('hasUsableAiCredential(provider, configuredBaseUrl)') &&
      read('apps/desktop/src/main/services/secrets.ts').includes('await resolveAiCredential(provider, requestedBaseUrl)'),
    'God Mode AI readiness diverges from runtime endpoint/keyless credential binding.',
  );
  assert(
    ui.includes('const inFlightRef = useRef(false)') &&
      ui.includes('if (inFlightRef.current) return null') &&
      ui.includes('inFlightRef.current = true') &&
      ui.includes('inFlightRef.current = false'),
    'God Mode renderer lacks synchronous one-action admission.',
  );

  const agent = read('apps/desktop/src/main/services/agent.ts');
  assert(agent.includes('let autonomousPass = 0') && agent.includes('autonomousPass < auto.config.maxIterations') && agent.includes('retryAfterPass'), 'Agent outer repair loop is missing or unbounded.');
  assert(agent.includes('Latest edits were not verified') && agent.includes('latestMutationVerified'), 'Agent does not suppress unverified completion.');
  const processEnvironment = read('apps/desktop/src/main/services/processEnvironment.ts');
  assert(processEnvironment.includes('ALLOWED_PROCESS_ENVIRONMENT_KEYS') && !processEnvironment.includes('...process.env'), 'Child-process environment helper is not a positive allowlist.');
  for (const launchSurface of ['preview.ts', 'verification.ts', 'isolatedWorkspaces.ts', 'agent.ts', 'dap.ts', 'lsp.ts']) {
    const source = read(`apps/desktop/src/main/services/${launchSurface}`);
    assert(source.includes('buildChildProcessEnvironment'), `${launchSurface} still inherits ambient Main credentials.`);
  }
  const predictive = read('apps/desktop/src/main/services/predictiveCompletion.ts');
  assert(
    predictive.includes('MAX_ACTIVE_PER_OWNER') && predictive.includes('MAX_ACTIVE_GLOBAL'),
    'Predictive requests are not globally and per-owner concurrency bounded.',
  );
  const lsp = read('apps/desktop/src/main/services/lsp.ts');
  assert(
    lsp.includes('MAX_LSP_HEADER_BYTES') &&
      lsp.includes('MAX_LSP_BODY_BYTES') &&
      lsp.includes('onProtocolError') &&
      lsp.includes('if (!app.isPackaged) roots.push(process.cwd())'),
    'LSP framing is unbounded or packaged resolution trusts the ambient working directory.',
  );
  const releaseScript = read('AXIOM EXE/build-axiom-exe.ps1');
  const envRemoval = releaseScript.indexOf("foreach ($name in @('CSC_LINK', 'CSC_KEY_PASSWORD', 'AXIOM_SIGNER_SHA1', 'AXIOM_SIGNER_SUBJECT'))");
  const npmInstall = releaseScript.indexOf('npm.cmd ci');
  const unsignedBuilder = releaseScript.indexOf('& $builder --win --dir --config.win.sign=null');
  const signerFunction = releaseScript.indexOf('function Invoke-DedicatedSigner');
  const signerCredentialScope = releaseScript.indexOf('$env:CSC_LINK = $signingLink', signerFunction);
  const signerInvocation = releaseScript.indexOf("Invoke-DedicatedSigner 'App' $unpacked");
  const unsignedNsis = releaseScript.indexOf('& $builder --win nsis --prepackaged $unpacked --config.win.sign=null');
  assert(
    envRemoval >= 0 &&
      envRemoval < npmInstall &&
      unsignedBuilder > npmInstall &&
      signerFunction > unsignedBuilder &&
      signerCredentialScope > signerFunction &&
      signerInvocation > signerCredentialScope &&
      unsignedNsis > signerInvocation &&
      releaseScript.includes("sign-release-artifacts.ps1') -Mode $mode -Path $target") &&
      (releaseScript.match(/verify-packaged-runtime\.cjs/g) || []).length === 2,
    'Build/package hooks receive signing credentials or bypass dedicated post-sign verification.',
  );
  const jobs = read('apps/desktop/src/main/services/godModeJobs.ts');
  assert(jobs.includes('resumeRunId: job.id') && jobs.includes("status: 'queued'"), 'Durable resume reuses an Agent run ID.');

  const collaboration = read('apps/desktop/src/main/services/collaboration.ts');
  assert(collaboration.includes('rootFingerprint') && collaboration.includes('redact'), 'Collaboration export lacks root privacy controls.');
  assert(collaboration.includes('cloudRootFingerprint') && collaboration.includes('AbortController') && collaboration.includes('MAX_EXPORT_BYTES'), 'Collaboration cloud export lacks opaque binding, cancellation, or payload bounds.');
  assert(collaboration.includes('linkedIds') && collaboration.includes('requireCloudSchemaAttestation'), 'Collaboration exports are not session-linked or cloud sync is not schema/RLS-attested.');
  assert(ui.includes('collaborationShareApprovalId === selectedSession.id') && ui.includes('collaborationMemberApproval === collaborationMemberTarget'), 'Collaboration confirmations are not bound to exact targets.');
  const migration = read('supabase/migrations/0006_god_mode_collaboration.sql');
  assert((migration.match(/enable row level security/g) || []).length === 2, 'Collaboration tables are not both RLS-enabled.');
  assert((migration.match(/set search_path = ''/g) || []).length >= 3, 'Security-definer collaboration helpers have a mutable search path.');
  assert(
    migration.includes('semantic_policy_count') &&
      migration.includes("p.roles = array['authenticated']::name[]") &&
      migration.includes("coalesce(p.with_check, '') like '%user_id <> auth.uid()%'"),
    'Collaboration attestation checks policy names but not authenticated owner/member semantics.',
  );
  const rlsTests = read('supabase/tests/rls_policies_test.sql');
  assert(
    rlsTests.includes('select plan(28)') &&
      rlsTests.includes('collaboration policies retain authenticated owner/member semantics'),
    'pgTAP collaboration policy-semantics coverage or assertion count is stale.',
  );

  const deployment = read('apps/desktop/src/main/services/deployment.ts');
  assert(deployment.includes('requireVerifiedPlan') && deployment.includes('currentCommit') && deployment.includes('commitSha'), 'Deployment is not verification-gated and commit-pinned.');
  const executeStart = deployment.indexOf('export async function executeDeployment(');
  const runRegistration = deployment.indexOf('runs.set(run.id, record)', executeStart);
  const firstPreflightAwait = deployment.indexOf('await currentCommit(root)', runRegistration);
  assert(
    executeStart >= 0 && runRegistration > executeStart && firstPreflightAwait > runRegistration,
    'Deployment cancellation is not registered before its first preflight await.',
  );
  assert(
    deployment.includes('artifactSha256: artifact.sha256') &&
      deployment.includes('snapshot.sha256 !== stored.plan.artifactSha256') &&
      deployment.includes('startStaticServer(owner.id, run.id, snapshot, controller.signal)'),
    'Local deployment bytes are not bound from one-shot plan through immutable serving.',
  );
  assert(
    deployment.includes('assertCleanTrackedWorktree(root)') &&
      deployment.includes('status.staged.length > 0 || status.unstaged.length > 0') &&
      deployment.includes('verification.cleanCommitSha?.toLowerCase() !== commitSha.toLowerCase()') &&
      deployment.includes('throwIfAborted(controller.signal)'),
    'Remote deployment is not completely clean-worktree, exact-commit verification, and cancellation gated.',
  );
  assert(
    deployment.includes('secretRef: `deployment.hook.${rootFingerprint}.${id}`') &&
      deployment.includes('target.hookRevision!') &&
      deployment.includes('target.hookUrlSha256!') &&
      mainIpc.includes("'Store Deployment Hook'") &&
      mainIpc.includes('normalizedUrlSha256: descriptor.hookUrlSha256'),
    'Deploy-hook storage is not root-bound, revision/digest-bound, and exact-native-confirmed.',
  );
  assert(
    deployment.includes("['64:ff9b:1::', 48]") &&
      deployment.includes('response.destroy()'),
    'Deploy-hook transport omits local-use NAT64 denial or redirect socket destruction.',
  );
  assert(deployment.includes('plans.delete(stored.plan.id)') && deployment.includes('record.ownerId === ownerId'), 'Deployment plans are replayable or run history is not owner-scoped.');
  assert(deployment.includes('request.headers.host !== expectedHost') && deployment.includes('sensitiveStaticPath') && deployment.includes('captureStaticSnapshot') && deployment.includes('snapshot.assets.get(pathname)'), 'Local deployment lacks exact-host, dot-secret, or immutable manifest serving.');
  assert(deployment.includes('MAX_STATIC_TOTAL_BYTES') && deployment.includes('sha256') && deployment.includes('asset.bytes'), 'Local deployment snapshot is not byte/hash bounded.');
  assert(deployment.includes('resolvePublicHookAddress') && deployment.includes('httpsRequest') && deployment.includes('servername: url.hostname') && deployment.includes('status >= 300 && status < 400'), 'Provider deployment lacks DNS-pinned HTTPS transport or redirect denial.');
  assert(deployment.includes('MAX_HOOK_RESPONSE_BYTES') && deployment.includes('controller.abort()'), 'Provider deployment lacks bounded response streaming or cancellation.');
  assert(ui.includes('deploymentApprovalId === deploymentPlan.id') && ui.includes('setDeploymentPlan(null)'), 'Deployment confirmation is not exact-plan-bound and consumed.');
  assert(!/FormData|readFile\([^)]*root|source archive|tar\b/i.test(deployment), 'Deployment appears to upload workspace source.');
  const secrets = read('apps/desktop/src/main/services/secrets.ts');
  assert(secrets.includes('OPAQUE_SECRET_KEY') && secrets.includes('safeStorage.encryptString'), 'Deploy hooks are not encrypted in Main.');

  for (const capability of [
    'context-intelligence', 'predictive-editing', 'autonomous-verification', 'secure-preview',
    'test-debug-ai', 'issue-to-pr', 'isolated-workspaces', 'sandboxed-extensions',
    'collaboration-background', 'preview-deployment',
  ]) assert(ui.includes(`'${capability}'`) || read('apps/desktop/src/common/godMode.ts').includes(`'${capability}'`), `Dashboard is missing ${capability}.`);
  assert(read('apps/desktop/src/renderer/src/state/layout.tsx').includes("'godmode'"), 'God Mode is not a primary view.');
  assert(read('apps/desktop/src/renderer/src/App.tsx').includes('workbench.view.godMode'), 'God Mode command palette command is missing.');
  assert(read('apps/desktop/src/renderer/src/workbench/OnboardingWizard.tsx').includes("'godmode'"), 'God Mode is absent from onboarding.');
  assert(read('apps/desktop/src/renderer/src/commands/commandBuses.ts').includes("'start-god-mode'"), 'Durable jobs do not launch through the AI dock bus.');

  const workerAndService = read('apps/desktop/src/main/extensionSandboxWorker.ts') + read('apps/desktop/src/main/services/extensionSandbox.ts');
  assert(!workerAndService.includes('ELECTRON_RUN_AS_NODE'), 'Extension sandbox introduced a third Electron-as-Node path.');
}

async function validateIsolatedWorkspaces(tempRoot) {
  const userData = path.join(tempRoot, 'isolated-user-data');
  const rootA = path.join(tempRoot, 'source-a');
  const rootB = path.join(tempRoot, 'source-b');
  await Promise.all([
    fsp.mkdir(rootA, { recursive: true }),
    fsp.mkdir(rootB, { recursive: true }),
  ]);
  await fsp.writeFile(path.join(rootA, 'package-lock.json'), '{}\n');
  let dirty = false;
  const service = load('apps/desktop/src/main/services/isolatedWorkspaces.ts', {
    electron: { app: { getPath: () => userData } },
    './git': {
      getStatus: async () => ({
        staged: dirty ? [{ type: 'modified', path: 'a.ts' }] : [],
        unstaged: [],
      }),
    },
    './systemGit': {
      cloneLocalRepository: async (_source, destination) => {
        await fsp.mkdir(destination, { recursive: true });
        await fsp.writeFile(path.join(destination, 'clone-marker.txt'), 'clone');
      },
    },
    './processTree': { terminateProcessTree: async () => undefined },
  });
  const input = { name: 'Clean clone', backend: 'local-clone', confirmation: true };
  await reject(() => service.createIsolatedWorkspace(rootA, { ...input, confirmation: false }), 'Isolated clone was created without confirmation.');
  const approvalA = service.prepareIsolatedWorkspaceCreationApproval(rootA, input);
  dirty = true;
  await reject(() => service.createIsolatedWorkspace(rootA, input, approvalA), 'Dirty source worktree was cloned as reproducible.');
  dirty = false;
  const profileA = await service.createIsolatedWorkspace(rootA, input, approvalA);
  const inputB = { ...input, name: 'Other root clone' };
  const profileB = await service.createIsolatedWorkspace(
    rootB,
    inputB,
    service.prepareIsolatedWorkspaceCreationApproval(rootB, inputB),
  );
  assert(profileA.status === 'ready' && profileA.reproducibilityFiles.includes('package-lock.json'), 'Managed clone did not retain reproducibility evidence.');
  const profilesA = await service.listIsolatedWorkspaces(rootA);
  const profilesB = await service.listIsolatedWorkspaces(rootB);
  assert(profilesA.some((item) => item.id === profileA.id) && profilesA.every((item) => path.resolve(item.sourceRoot) === path.resolve(rootA)) && !profilesA.some((item) => item.id === profileB.id), 'Profile listing leaked another source root.');
  assert(profilesB.length === 1 && profilesB[0].id === profileB.id, 'Second source root profile was not isolated.');

  const owner = new EventEmitter();
  owner.id = 12;
  await reject(() => service.runIsolatedWorkspaceCommand(owner, rootA, profileA.id, 'node --version', false), 'Isolated command ran without confirmation.');
  await reject(() => service.runIsolatedWorkspaceCommand(owner, rootB, profileA.id, 'node --version', true), 'Cross-root profile execution was accepted.');
  await reject(
    () => service.runIsolatedWorkspaceCommand(owner, rootA, profileA.id, 'echo first\necho second', true),
    'Multiline isolated command was accepted.',
  );
  await reject(
    () => service.runIsolatedWorkspaceCommand(owner, rootA, profileA.id, 'x'.repeat(1_001), true),
    'Oversized isolated command was accepted.',
  );

  const failureCommand = process.platform === 'win32' ? 'exit /b 3' : 'exit 3';
  const failureApproval = await service.prepareIsolatedCommandApproval(
    rootA,
    profileA.id,
    failureCommand,
  );
  const failed = await service.runIsolatedWorkspaceCommand(
    owner,
    rootA,
    profileA.id,
    failureCommand,
    true,
    failureApproval,
  );
  assert(!failed.passed && failed.exitCode === 3, 'Isolated command exit status was not preserved.');
  const passCommand = 'echo isolated-ok';
  const passApproval = await service.prepareIsolatedCommandApproval(rootA, profileA.id, passCommand);
  const passed = await service.runIsolatedWorkspaceCommand(
    owner,
    rootA,
    profileA.id,
    passCommand,
    true,
    passApproval,
  );
  assert(passed.passed && passed.output.includes('isolated-ok'), 'Profile lease was not released for the next bounded command.');

  await reject(() => service.removeIsolatedWorkspace(rootA, profileA.id, false), 'Managed clone was removed without confirmation.');
  await service.removeIsolatedWorkspace(rootB, profileA.id, true);
  assert(fs.existsSync(profileA.workspacePath), 'Cross-root removal deleted a managed clone.');
  await service.removeIsolatedWorkspace(rootA, profileA.id, true);
  assert(!fs.existsSync(path.dirname(profileA.workspacePath)), 'Managed clone directory was not safely removed.');
}

async function validateGithubApiTransport() {
  let disconnectedOwner = null;
  let observed = null;
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      observed = { url: String(url), options };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const service = load('apps/desktop/src/main/services/githubApi.ts', {
      './githubScm': {
        getGithubCredentialForGit: async () => 'test-token-not-logged',
        disconnectGithub: async (ownerId) => { disconnectedOwner = ownerId; },
      },
    });
    await reject(() => service.githubApiRequest(3, '/user', 'GET'), 'Non-allow-listed GitHub API path was accepted.');
    await reject(() => service.githubApiRequest(3, '/repos/octocat/demo/pulls', 'POST', { body: 'x'.repeat(130 * 1024) }), 'Oversized GitHub API request was accepted.');
    const response = await service.githubApiRequest(3, '/repos/octocat/demo/issues/1', 'GET');
    assert(response.ok && observed.url === 'https://api.github.com/repos/octocat/demo/issues/1', 'GitHub API request escaped its fixed origin.');
    assert(observed.options.redirect === 'error' && observed.options.headers.Authorization === 'Bearer test-token-not-logged', 'GitHub API transport lost redirect or Main-only authorization policy.');

    global.fetch = async () => new Response('{}', { status: 401 });
    await reject(() => service.githubApiRequest(77, '/repos/octocat/demo/issues/1', 'GET'), 'GitHub 401 did not become a terminal authorization error.');
    assert(disconnectedOwner === 77, 'GitHub 401 invalidated the wrong renderer owner.');
  } finally {
    global.fetch = originalFetch;
  }
}

async function validateCollaboration(tempRoot) {
  const userData = path.join(tempRoot, 'collaboration-user-data');
  const rootA = path.join(tempRoot, 'collaboration-root-a');
  const rootB = path.join(tempRoot, 'collaboration-root-b');
  await Promise.all([fsp.mkdir(rootA, { recursive: true }), fsp.mkdir(rootB, { recursive: true })]);

  const secret = `ghp_${'A'.repeat(36)}`;
  let jobs = [
    {
      id: 'job-1',
      kind: 'autonomous-run',
      root: rootA,
      title: `Work in ${rootA}`,
      status: 'completed',
      phase: 'summarize',
      createdAt: 1,
      updatedAt: 2,
      startedAt: 1,
      endedAt: 2,
      progress: 1,
      iteration: 1,
      maxIterations: 2,
      ownerWindowId: 44,
      resumeRunId: null,
      resumable: false,
      summary: `Bearer private-token ${secret} at ${rootA}`,
      error: null,
      evidence: [
        {
          id: 'evidence-1',
          kind: 'test',
          label: 'Test output',
          passed: true,
          summary: `token=${secret}`,
          createdAt: 2,
          path: path.join(rootA, 'src', 'index.ts'),
          command: `tool --root "${rootA}" --token=${secret}`,
        },
      ],
    },
  ];
  jobs.push({
    ...jobs[0],
    id: 'unrelated-job',
    title: 'Unrelated work',
    evidence: [{ ...jobs[0].evidence[0], id: 'unrelated-evidence' }],
  });
  const listedJobRoots = [];
  let authUser = null;
  let nextCloudError = null;
  let deferNextUpsert = false;
  let pendingUpsert = null;
  let attestationToken = 'axiom-god-mode-collaboration-v1-rls';
  const upserts = [];
  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: authUser }, error: null }),
    },
    rpc: (name) => ({
      abortSignal: (signal) =>
        Promise.resolve({
          data: name === 'attest_god_mode_collaboration' ? attestationToken : null,
          error: null,
          signal,
        }),
    }),
    from: (table) => ({
      upsert: (row, options) => ({
        abortSignal: (signal) => {
          upserts.push({ table, row, options, signal });
          const result = { error: nextCloudError };
          nextCloudError = null;
          if (!deferNextUpsert) return Promise.resolve(result);
          deferNextUpsert = false;
          return new Promise((resolvePending) => {
            pendingUpsert = () => resolvePending(result);
          });
        },
      }),
    }),
  };
  const service = load('apps/desktop/src/main/services/collaboration.ts', {
    electron: { app: { getPath: () => userData } },
    './godModeJobs': {
      listGodModeJobs: async (rootValue) => {
        listedJobRoots.push(rootValue);
        return jobs;
      },
    },
    './supabase': { getSupabase: () => supabase },
  });

  const sessionA = await service.createCollaborationSession(rootA, { title: 'Engineering handoff' });
  const sessionB = await service.createCollaborationSession(rootB, { title: 'Other workspace' });
  assert((await service.listCollaborationSessions(rootA)).every((item) => item.id !== sessionB.id), 'Collaboration list leaked another workspace root.');
  assert((await service.listCollaborationSessions(rootB)).length === 1, 'Collaboration persistence lost the second workspace session.');
  await reject(
    () => service.addCollaborationEvent(rootB, sessionA.id, { kind: 'note', text: 'cross-root', evidenceIds: [] }),
    'Collaboration event crossed its workspace root.',
  );

  const storePath = path.join(userData, 'god-mode', 'collaboration.json');
  const persisted = JSON.parse(await fsp.readFile(storePath, 'utf8'));
  const persistedA = persisted.sessions.find((item) => item.id === sessionA.id);
  persistedA.events = Array.from({ length: 300 }, (_value, index) => ({
    id: `event-${index}`,
    sessionId: 'forged-session',
    actorId: persisted.deviceActorId,
    kind: 'note',
    text: 'x'.repeat(5_000),
    createdAt: index + 1,
    evidenceIds: Array.from({ length: 150 }, (_entry, evidenceIndex) => `evidence-${evidenceIndex}`),
  }));
  persistedA.members.push({ id: 'not-a-uuid', displayName: 'forged', role: 'owner', lastSeenAt: 0 });
  await fsp.writeFile(storePath, JSON.stringify(persisted), 'utf8');
  const normalized = (await service.listCollaborationSessions(rootA)).find((item) => item.id === sessionA.id);
  assert(normalized.events.length === 250, 'Persisted collaboration events were not bounded.');
  assert(normalized.events.every((event) => event.sessionId === sessionA.id && event.text.length === 4_000 && event.evidenceIds.length === 100), 'Persisted collaboration events were not deeply normalized.');
  assert(normalized.members.every((member) => member.id !== 'not-a-uuid'), 'Malformed persisted collaboration member was accepted.');

  await service.addCollaborationEvent(rootA, sessionA.id, {
    kind: 'decision',
    text: `Use ${rootA} with Bearer private-token and ${secret}; endpoint=https://user:pass@example.test/?token=${secret}`,
    evidenceIds: ['job-1', 'evidence-1', `token=${secret}`],
  });
  const exported = await service.exportCollaborationSession(rootA, sessionA.id);
  const exportText = JSON.stringify(exported);
  assert(exported.session.rootFingerprint === '<workspace>', 'Collaboration export leaked its local root fingerprint.');
  assert(
    exported.jobs.length === 1 &&
      exported.jobs[0].id === 'job-1' &&
      exported.jobs[0].root === '<workspace>' &&
      exported.jobs[0].ownerWindowId === null,
    'Collaboration export retained an unrelated job or job root/owner authority.',
  );
  assert(
    exported.evidence.length === 1 &&
      exported.evidence[0].id === 'evidence-1' &&
      exported.evidence[0].path === '<workspace>/src/index.ts',
    'Collaboration export did not enforce exact evidence linkage or workspace-relative paths.',
  );
  assert(!exportText.toLowerCase().includes(rootA.toLowerCase()) && !exportText.includes(secret) && !exportText.includes('private-token'), 'Collaboration export leaked a root or secret-shaped value.');
  assert(listedJobRoots.every((value) => value === rootA), 'Collaboration export queried jobs outside its trusted root.');

  const linkedOnly = await service.exportCollaborationSession(rootA, sessionA.id);
  assert(
    linkedOnly.jobs.every((job) => job.id !== 'unrelated-job') &&
      linkedOnly.evidence.every((item) => item.id !== 'unrelated-evidence'),
    'Session export included same-root jobs or evidence that no event linked.',
  );

  const shareApproved = async () => {
    const approval = await service.prepareCollaborationShareApproval(rootA, sessionA.id);
    return service.shareCollaborationSession(rootA, sessionA.id, true, approval);
  };
  await reject(
    () => service.shareCollaborationSession(rootA, sessionA.id, false),
    'Collaboration session was shared without confirmation.',
  );
  await reject(
    () => shareApproved(),
    'Unauthenticated collaboration sharing was accepted.',
  );
  assert((await service.listCollaborationSessions(rootA)).find((item) => item.id === sessionA.id).cloudState === 'error', 'Collaboration auth failure was not reflected locally.');

  authUser = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.test' };
  attestationToken = 'wrong-schema';
  await reject(
    () => shareApproved(),
    'Unattested collaboration backend was accepted as synced.',
  );
  attestationToken = 'axiom-god-mode-collaboration-v1-rls';
  const shared = await shareApproved();
  const sessionWrite = upserts.find((item) => item.table === 'collaboration_sessions');
  assert(shared.shared && shared.cloudState === 'synced', 'Successful collaboration share did not become synced.');
  assert(sessionWrite && /^[0-9a-f]{64}$/.test(sessionWrite.row.root_fingerprint), 'Cloud collaboration root binding is malformed.');
  assert(sessionWrite.row.root_fingerprint !== sessionA.rootFingerprint && !JSON.stringify(sessionWrite.row.body).includes(secret), 'Cloud collaboration payload leaked a path-derived root fingerprint or secret.');

  await service.addCollaborationEvent(rootA, sessionA.id, { kind: 'checkpoint', text: 'before race', evidenceIds: [] });
  deferNextUpsert = true;
  const racingShare = shareApproved();
  for (let attempt = 0; attempt < 200 && !pendingUpsert; attempt++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert(pendingUpsert, 'Collaboration race test did not reach the cloud write.');
  await service.addCollaborationEvent(rootA, sessionA.id, { kind: 'handoff', text: 'changed during share', evidenceIds: [] });
  pendingUpsert();
  pendingUpsert = null;
  const raced = await racingShare;
  assert(raced.cloudState === 'syncing', 'Concurrent local collaboration change was incorrectly marked synced.');
  await shareApproved();

  await reject(
    () => service.addCloudCollaborationMember(rootA, sessionA.id, 'bad-id', 'viewer', true),
    'Invalid collaborator UUID was accepted.',
  );
  await reject(
    () => service.addCloudCollaborationMember(rootA, sessionA.id, '22222222-2222-4222-8222-222222222222', 'owner', true),
    'Owner collaborator role was accepted.',
  );
  await reject(
    () => service.addCloudCollaborationMember(rootA, sessionA.id, authUser.id, 'viewer', true),
    'Session owner was added as their own collaborator.',
  );
  await shareApproved();
  const memberId = '22222222-2222-4222-8222-222222222222';
  const memberUpdated = await service.addCloudCollaborationMember(rootA, sessionA.id, memberId, 'reviewer', true);
  const memberWrite = upserts.find((item) => item.table === 'collaboration_members' && item.row.user_id === memberId);
  assert(memberWrite && memberWrite.row.invited_by === authUser.id && memberWrite.row.role === 'reviewer', 'Authenticated collaborator write lost owner/role binding.');
  assert(memberUpdated.members.some((item) => item.id === memberId && item.role === 'reviewer') && memberUpdated.cloudState === 'syncing', 'Local collaborator state is not an honest pending re-share.');
  await reject(
    () => service.addCloudCollaborationMember(rootB, sessionA.id, memberId, 'viewer', true),
    'Collaborator update crossed its workspace root.',
  );

  nextCloudError = { message: 'backend details must not escape' };
  await reject(
    () => shareApproved(),
    'Collaboration backend failure was accepted.',
  );
  assert((await service.listCollaborationSessions(rootA)).find((item) => item.id === sessionA.id).cloudState === 'error', 'Collaboration backend failure was not persisted as error state.');

  const migration = read('supabase/migrations/0006_god_mode_collaboration.sql');
  assert((migration.match(/enable row level security/g) || []).length === 2, 'Collaboration RLS is not enabled on both tables.');
  assert((migration.match(/set search_path = ''/g) || []).length >= 3, 'Collaboration security-definer functions have a mutable search path.');
  assert(migration.includes("jsonb_typeof(body) = 'object'") && migration.includes('user_id <> auth.uid()'), 'Collaboration cloud schema lacks body/member guards.');
  assert(migration.includes('attest_god_mode_collaboration') && migration.includes('axiom-god-mode-collaboration-v1-rls'), 'Collaboration migration lacks the desktop schema/RLS attestation RPC.');
}

async function validateDeployment(tempRoot) {
  const workspace = path.join(tempRoot, 'deployment-workspace');
  const output = path.join(workspace, 'dist');
  const outside = path.join(tempRoot, 'deployment-outside');
  await Promise.all([
    fsp.mkdir(path.join(output, '.git'), { recursive: true }),
    fsp.mkdir(outside, { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(output, 'index.html'), '<h1>safe preview</h1>'),
    fsp.writeFile(path.join(output, '.env.production'), 'TOKEN=must-not-serve'),
    fsp.writeFile(path.join(output, '.git', 'config'), 'must-not-serve'),
    fsp.writeFile(path.join(outside, 'secret.txt'), 'outside-secret'),
  ]);
  let linked = false;
  try {
    await fsp.symlink(outside, path.join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch {
    // Some locked-down Windows hosts disallow link creation; containment is also checked structurally.
  }

  const commitA = 'a'.repeat(40);
  const commitB = 'b'.repeat(40);
  let currentSha = commitA;
  let deferNextCommit = false;
  let resolveDeferredCommit = null;
  let trackedDirty = false;
  let remotes = [];
  let githubMode = 'success';
  let githubCall = null;
  let hookMode = 'success';
  let hookCall = null;
  const hookSecrets = new Map();
  let hookSecretRevision = 0;
  const verificationCalls = [];
  const originalFetch = global.fetch;
  let hookDnsAddresses = [{ address: '93.184.216.34', family: 4 }];
  const mockHttpsRequest = (options, callback) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = (error) => {
      if (request.destroyed) return request;
      request.destroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
      return request;
    };
    request.end = (body) => {
      hookCall = { options, body: String(body ?? ''), request };
      if (hookMode === 'deferred') return request;
      if (hookMode === 'network-error') {
        queueMicrotask(() => request.emit('error', new Error('mock network failure')));
        return request;
      }
      const response = new EventEmitter();
      response.statusCode = hookMode === 'redirect' ? 302 : 200;
      response.headers = {};
      response.resume = () => undefined;
      response.destroy = () => {
        response.destroyed = true;
      };
      let responseBody;
      if (hookMode === 'oversized') {
        responseBody = Buffer.alloc(129 * 1024, 120);
        response.headers['content-length'] = String(responseBody.byteLength);
      } else if (hookMode === 'query-url') {
        responseBody = Buffer.from(
          JSON.stringify({ preview_url: 'https://preview.example.test/?token=secret' }),
        );
      } else {
        responseBody = Buffer.from(
          JSON.stringify({
            preview_url: 'https://preview.example.test/site',
            inspector_url: 'https://dashboard.example.test/run',
          }),
        );
      }
      queueMicrotask(() => {
        callback(response);
        if (response.statusCode >= 300 && response.statusCode < 400) return;
        if (!response.destroyed) response.emit('data', responseBody);
        if (!response.destroyed) response.emit('end');
      });
      return request;
    };
    return request;
  };

  const service = load('apps/desktop/src/main/services/deployment.ts', {
    'node:dns/promises': {
      lookup: async () => hookDnsAddresses,
    },
    'node:https': { request: mockHttpsRequest },
    './systemGit': {
      currentCommit: async () => {
        if (!deferNextCommit) return currentSha;
        deferNextCommit = false;
        return new Promise((resolveCommit) => {
          resolveDeferredCommit = () => resolveCommit(currentSha);
        });
      },
      getRepositoryInfo: async () => ({ remotes }),
    },
    './git': {
      getStatus: async () => ({
        staged: trackedDirty ? [{ type: 'modified', path: 'src/tracked.ts' }] : [],
        unstaged: [],
      }),
    },
    './githubApi': {
      githubApiRequest: async (ownerId, requestPath, method, body, signal) => {
        githubCall = { ownerId, requestPath, method, body, signal };
        if (githubMode === 'failure') return { status: 422, ok: false, payload: null };
        if (githubMode === 'deferred') {
          return new Promise((resolveRequest, rejectRequest) => {
            signal.addEventListener('abort', () => rejectRequest(new Error('aborted')), { once: true });
          });
        }
        return { status: 204, ok: true, payload: null };
      },
    },
    './verification': {
      requireVerifiedPlan: async (ownerId, planId, rootValue) => {
        verificationCalls.push({ ownerId, planId, rootValue });
        return {
          planId,
          startedAt: 1,
          endedAt: 2,
          passed: true,
          level: 'verified',
          snapshotSha256: 'c'.repeat(64),
          snapshotFileCount: 2,
          snapshotBytes: 128,
          sourceFingerprint: 'd'.repeat(64),
          cleanCommitSha: commitA,
          results: [
            {
              checkId: 'typecheck',
              passed: true,
              exitCode: 0,
              durationMs: 1,
              summary: 'Typecheck passed',
              failures: [],
              flakySignal: false,
            },
          ],
        };
      },
    },
    './secrets': {
      setDeploymentHookSecret: async (key, value) => {
        const parsed = new URL(value);
        const metadata = {
          value,
          revision: (++hookSecretRevision).toString(16).padStart(32, '0'),
          origin: parsed.origin,
          urlSha256: crypto.createHash('sha256').update(parsed.toString()).digest('hex'),
        };
        hookSecrets.set(key, metadata);
        return {
          revision: metadata.revision,
          origin: metadata.origin,
          urlSha256: metadata.urlSha256,
        };
      },
      resolveDeploymentHookSecret: async (key, expectedOrigin, expectedRevision, expectedUrlSha256) => {
        const metadata = hookSecrets.get(key);
        if (
          !metadata ||
          metadata.origin !== expectedOrigin ||
          metadata.revision !== expectedRevision ||
          metadata.urlSha256 !== expectedUrlSha256
        ) {
          throw new Error('bound hook missing');
        }
        return metadata.value;
      },
    },
  });
  const deploymentCleanup = () => service.stopAllDeployments();
  failureCleanups.add(deploymentCleanup);

  const owner = Object.assign(new EventEmitter(), { id: 501 });
  const otherOwner = Object.assign(new EventEmitter(), { id: 502 });
  const rawExecuteDeployment = service.executeDeployment;
  const executeApproved = async (deploymentOwner, deploymentRoot, input) => {
    const approval = await service.prepareDeploymentExecutionApproval(
      deploymentOwner.id,
      deploymentRoot,
      input,
    );
    return rawExecuteDeployment(deploymentOwner, deploymentRoot, input, approval);
  };
  const localTarget = {
    id: 'local-preview',
    name: 'Local preview',
    provider: 'local-static',
    outputDirectory: 'dist',
  };
  await reject(
    () => service.createDeploymentPlan(owner, workspace, { ...localTarget, provider: 'unknown' }),
    'Unknown deployment provider was accepted.',
  );
  await reject(
    () => service.createDeploymentPlan(owner, workspace, { ...localTarget, outputDirectory: '../outside' }),
    'Traversing static output directory was accepted.',
  );
  const stalePlan = await service.createDeploymentPlan(owner, workspace, localTarget);
  assert(stalePlan.commitSha === commitA && /^[0-9a-f-]{36}$/.test(stalePlan.id), 'Deployment plan is not commit-pinned with an opaque id.');
  currentSha = commitB;
  await reject(
    () => executeApproved(owner, workspace, { planId: stalePlan.id, verificationPlanId: 'verify-1', confirmation: true }),
    'Deployment plan survived a commit change.',
  );
  currentSha = commitA;

  const preflightOwner = Object.assign(new EventEmitter(), { id: 503 });
  const preflightPlan = await service.createDeploymentPlan(preflightOwner, workspace, localTarget);
  const preflightInput = {
    planId: preflightPlan.id,
    verificationPlanId: 'verify-preflight-cancel',
    confirmation: true,
  };
  const preflightApproval = await service.prepareDeploymentExecutionApproval(
    preflightOwner.id,
    workspace,
    preflightInput,
  );
  deferNextCommit = true;
  const pendingPreflight = rawExecuteDeployment(
    preflightOwner,
    workspace,
    preflightInput,
    preflightApproval,
  );
  const activePreflight = service
    .listDeployments(preflightOwner.id, workspace)
    .find((run) => run.planId === preflightPlan.id);
  assert(activePreflight?.status === 'deploying', 'Deployment run was not registered before commit preflight.');
  await service.stopDeploymentsForWorkspace(workspace);
  assert(resolveDeferredCommit, 'Deferred deployment commit preflight was not reached.');
  resolveDeferredCommit();
  resolveDeferredCommit = null;
  const cancelledPreflight = await pendingPreflight;
  assert(cancelledPreflight.status === 'cancelled', 'Workspace revocation did not cancel deployment preflight.');

  const changedArtifactPlan = await service.createDeploymentPlan(owner, workspace, localTarget);
  assert(
    /^[0-9a-f]{64}$/.test(changedArtifactPlan.artifactSha256) &&
      changedArtifactPlan.artifactFileCount === 1 &&
      changedArtifactPlan.artifactBytes > 0,
    'Local deployment plan did not retain exact bounded artifact metadata.',
  );
  await fsp.writeFile(path.join(output, 'index.html'), '<h1>changed after plan approval</h1>');
  await reject(
    () => executeApproved(owner, workspace, {
      planId: changedArtifactPlan.id,
      verificationPlanId: 'verify-artifact-change',
      confirmation: true,
    }),
    'Local deployment accepted bytes that changed after one-shot plan approval.',
  );
  await fsp.writeFile(path.join(output, 'index.html'), '<h1>safe preview</h1>');

  const localPlan = await service.createDeploymentPlan(owner, workspace, localTarget);
  assert(owner.listenerCount('destroyed') === 1, 'Deployment plans accumulated owner lifecycle listeners.');
  await reject(
    () => executeApproved(otherOwner, workspace, { planId: localPlan.id, verificationPlanId: 'verify-1', confirmation: true }),
    'Another renderer executed an owned deployment plan.',
  );
  await reject(
    () => executeApproved(owner, workspace, { planId: localPlan.id, verificationPlanId: 'verify-1', confirmation: false }),
    'Deployment ran without explicit confirmation.',
  );
  const localRun = await executeApproved(owner, workspace, {
    planId: localPlan.id,
    verificationPlanId: 'verify-local',
    confirmation: true,
  });
  assert(localRun.status === 'ready' && localRun.commitSha === commitA && localRun.previewUrl.startsWith('http://127.0.0.1:'), 'Local deployment did not bind verified commit to loopback preview.');
  assert(verificationCalls.some((call) => call.ownerId === owner.id && call.rootValue === workspace), 'Deployment verification lost owner/root binding.');
  await reject(
    () => executeApproved(owner, workspace, { planId: localPlan.id, verificationPlanId: 'verify-local', confirmation: true }),
    'One-shot deployment plan was replayed.',
  );

  const indexResponse = await originalFetch(localRun.previewUrl);
  assert(indexResponse.status === 200 && (await indexResponse.text()).includes('safe preview'), 'Local static preview did not serve its bounded index.');
  await fsp.writeFile(path.join(output, 'index.html'), '<h1>mutated after verification</h1>');
  const immutableResponse = await originalFetch(localRun.previewUrl);
  const immutableText = await immutableResponse.text();
  assert(immutableResponse.status === 200 && immutableText.includes('safe preview') && !immutableText.includes('mutated after verification'), 'Local static preview read mutable workspace output after snapshot capture.');
  const headResponse = await originalFetch(localRun.previewUrl, { method: 'HEAD' });
  assert(headResponse.status === 200 && (await headResponse.text()) === '', 'Local static preview mishandled HEAD.');
  assert((await originalFetch(localRun.previewUrl, { method: 'POST' })).status === 405, 'Local static preview accepted a mutating method.');
  assert((await originalFetch(new URL('.env.production', localRun.previewUrl))).status === 403, 'Local static preview served a dot-secret file.');
  assert((await originalFetch(new URL('.git/config', localRun.previewUrl))).status === 403, 'Local static preview served Git metadata.');
  assert((await originalFetch(`${localRun.previewUrl}..%5coutside.txt`)).status !== 200, 'Local static preview accepted encoded traversal.');
  if (linked) {
    assert((await originalFetch(new URL('linked/secret.txt', localRun.previewUrl))).status !== 200, 'Local static preview followed an escaping symlink/junction.');
  }
  const wrongHostStatus = await new Promise((resolveStatus, rejectStatus) => {
    const request = http.request(
      localRun.previewUrl,
      { headers: { Host: 'rebind.example.test' } },
      (response) => {
        response.resume();
        response.once('end', () => resolveStatus(response.statusCode));
      },
    );
    request.once('error', rejectStatus);
    request.end();
  });
  assert(wrongHostStatus === 421, 'Local static preview accepted a DNS-rebinding Host header.');
  assert(service.listDeployments(otherOwner.id, workspace).length === 0, 'Deployment history leaked across renderer owners.');
  await reject(() => service.cancelDeployment(otherOwner.id, localRun.id), 'Another renderer stopped a local deployment.');
  await service.cancelDeployment(owner.id, localRun.id);
  assert(service.listDeployments(owner.id, workspace).find((run) => run.id === localRun.id).status === 'cancelled', 'Local preview cancellation was not retained.');
  await reject(() => originalFetch(localRun.previewUrl), 'Cancelled local preview server remained reachable.');

  remotes = [
    {
      name: 'origin',
      github: true,
      fetchUrl: 'git@github.com:octo/demo.git',
      pushUrl: 'git@github.com:other/demo.git',
    },
  ];
  const githubTarget = {
    id: 'actions-preview',
    name: 'Actions preview',
    provider: 'github-actions',
    repository: 'octo/demo',
    workflow: 'preview.yml',
    ref: 'main',
  };
  const mismatchedPlan = await service.createDeploymentPlan(owner, workspace, githubTarget);
  await reject(
    () => executeApproved(owner, workspace, { planId: mismatchedPlan.id, verificationPlanId: 'verify-actions', confirmation: true }),
    'GitHub deployment accepted mismatched fetch/push destinations.',
  );
  assert(githubCall === null, 'GitHub dispatch occurred before exact remote validation.');
  remotes[0].pushUrl = 'ssh://git@github.com/octo/demo.git';
  const dirtyRemotePlan = await service.createDeploymentPlan(owner, workspace, githubTarget);
  trackedDirty = true;
  await reject(
    () => executeApproved(owner, workspace, {
      planId: dirtyRemotePlan.id,
      verificationPlanId: 'verify-actions-dirty',
      confirmation: true,
    }),
    'Remote deployment accepted dirty tracked workspace bytes for a commit-only dispatch.',
  );
  trackedDirty = false;
  assert(githubCall === null, 'Remote dispatch occurred before clean tracked-state enforcement.');
  const githubPlan = await service.createDeploymentPlan(owner, workspace, githubTarget);
  const githubRun = await executeApproved(owner, workspace, {
    planId: githubPlan.id,
    verificationPlanId: 'verify-actions',
    confirmation: true,
  });
  assert(githubRun.status === 'queued' && githubCall.requestPath.endsWith('/actions/workflows/preview.yml/dispatches'), 'GitHub workflow dispatch was not queued on its allow-listed path.');
  assert(githubCall.body.ref === 'main' && githubCall.body.inputs.commit_sha === commitA && !JSON.stringify(githubCall.body).includes(workspace), 'GitHub dispatch was not commit-bound or leaked source/root data.');
  await reject(() => service.cancelDeployment(owner.id, githubRun.id), 'Accepted external workflow was misleadingly cancelled locally.');

  githubMode = 'deferred';
  githubCall = null;
  const cancelGithubPlan = await service.createDeploymentPlan(owner, workspace, githubTarget);
  const pendingGithub = executeApproved(owner, workspace, {
    planId: cancelGithubPlan.id,
    verificationPlanId: 'verify-actions-cancel',
    confirmation: true,
  });
  let activeGithub = null;
  for (let attempt = 0; attempt < 200 && (!activeGithub || !githubCall); attempt++) {
    activeGithub = service.listDeployments(owner.id, workspace).find((run) => run.planId === cancelGithubPlan.id);
    if (!activeGithub || !githubCall) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  assert(activeGithub?.status === 'deploying' && githubCall, 'Active GitHub deployment did not reach dispatch for cancellation.');
  await service.cancelDeployment(owner.id, activeGithub.id);
  const cancelledGithub = await pendingGithub;
  assert(cancelledGithub.status === 'cancelled' && githubCall.signal.aborted, 'GitHub deployment cancellation did not abort the Main request.');
  githubMode = 'success';

  await reject(() => service.saveDeploymentHook(workspace, 'hook', 'http://deploy.example.test/run'), 'Plain-HTTP deploy hook was accepted.');
  await reject(() => service.saveDeploymentHook(workspace, 'hook', 'https://user:pass@deploy.example.test/run'), 'Credential-bearing deploy hook was accepted.');
  await reject(() => service.saveDeploymentHook(workspace, 'hook', 'https://127.0.0.1/run'), 'Loopback deploy hook was accepted.');
  await reject(() => service.saveDeploymentHook(workspace, 'hook', 'https://169.254.169.254/latest'), 'Metadata-network deploy hook was accepted.');
  const hookBinding = await service.saveDeploymentHook(
    workspace,
    'hook',
    'https://deploy.example.test/run?token=hook-secret-value',
  );
  const secondHookBinding = await service.saveDeploymentHook(
    workspace,
    'hook',
    'https://deploy.example.test/other?token=other-secret-value',
  );
  assert(
    hookBinding.secretRef === secondHookBinding.secretRef &&
      /^deployment\.hook\.[0-9a-f]{64}\.hook$/.test(hookBinding.secretRef) &&
      hookSecrets.size === 1 &&
      hookBinding.hookRevision !== secondHookBinding.hookRevision &&
      hookBinding.hookUrlSha256 !== secondHookBinding.hookUrlSha256 &&
      !JSON.stringify(hookBinding).includes('hook-secret-value') &&
      !JSON.stringify(secondHookBinding).includes('other-secret-value'),
    'Deploy-hook storage was not root-scoped, idempotent per target, revision-bound, or returned its secret.',
  );
  const activeHookBinding = await service.saveDeploymentHook(
    workspace,
    'hook',
    'https://deploy.example.test/run?token=hook-secret-value',
  );
  const hookTarget = {
    id: 'hook',
    name: 'Provider hook',
    provider: 'deploy-hook',
    ...activeHookBinding,
  };

  try {
    const hookPlan = await service.createDeploymentPlan(owner, workspace, hookTarget);
    const hookRun = await executeApproved(owner, workspace, {
      planId: hookPlan.id,
      verificationPlanId: 'verify-hook',
      confirmation: true,
    });
    assert(
      hookRun.status === 'queued' &&
        hookRun.previewUrl === 'https://preview.example.test/site' &&
        hookRun.evidence.at(-1)?.passed === null,
      'Deploy hook was not retained as externally unverified queued work with its safe provider URL.',
    );
    const hookBody = JSON.parse(hookCall.body);
    assert(
      hookCall.options.hostname === '93.184.216.34' &&
        hookCall.options.servername === 'deploy.example.test' &&
        hookCall.options.path === '/run?token=hook-secret-value' &&
        hookBody.commit === commitA &&
        Object.keys(hookBody).sort().join(',') === 'commit,source',
      'Deploy hook lost DNS pinning, TLS hostname binding, commit binding, or sent extra workspace data.',
    );

    hookMode = 'redirect';
    const redirectPlan = await service.createDeploymentPlan(owner, workspace, hookTarget);
    await reject(
      () => executeApproved(owner, workspace, { planId: redirectPlan.id, verificationPlanId: 'verify-hook-redirect', confirmation: true }),
      'Deploy-hook redirect was followed or accepted.',
    );

    hookMode = 'success';
    hookDnsAddresses = [{ address: '127.0.0.1', family: 4 }];
    const privateDnsPlan = await service.createDeploymentPlan(owner, workspace, hookTarget);
    await reject(
      () => executeApproved(owner, workspace, { planId: privateDnsPlan.id, verificationPlanId: 'verify-hook-private-dns', confirmation: true }),
      'Deploy-hook DNS resolution to loopback was accepted.',
    );
    hookDnsAddresses = [{ address: '93.184.216.34', family: 4 }];

    hookMode = 'query-url';
    const queryPlan = await service.createDeploymentPlan(owner, workspace, hookTarget);
    const queryRun = await executeApproved(owner, workspace, {
      planId: queryPlan.id,
      verificationPlanId: 'verify-hook-query',
      confirmation: true,
    });
    assert(queryRun.status === 'queued' && queryRun.previewUrl === null, 'Secret-bearing provider URL crossed into renderer state.');

    hookMode = 'oversized';
    const oversizedPlan = await service.createDeploymentPlan(owner, workspace, hookTarget);
    await reject(
      () => executeApproved(owner, workspace, { planId: oversizedPlan.id, verificationPlanId: 'verify-hook-size', confirmation: true }),
      'Unbounded deploy-hook response was accepted.',
    );

    hookMode = 'network-error';
    const failedPlan = await service.createDeploymentPlan(owner, workspace, hookTarget);
    await reject(
      () => executeApproved(owner, workspace, { planId: failedPlan.id, verificationPlanId: 'verify-hook-failure', confirmation: true }),
      'Deploy-hook transport failure was accepted.',
    );
    const failedRun = service.listDeployments(owner.id, workspace).find((run) => run.planId === failedPlan.id);
    assert(failedRun.status === 'failed' && !failedRun.summary.includes('hook-secret-value'), 'Deploy-hook failure exposed its secret URL.');

    hookMode = 'deferred';
    hookCall = null;
    const cancelHookPlan = await service.createDeploymentPlan(owner, workspace, hookTarget);
    const pendingHook = executeApproved(owner, workspace, {
      planId: cancelHookPlan.id,
      verificationPlanId: 'verify-hook-cancel',
      confirmation: true,
    });
    let activeHook = null;
    for (let attempt = 0; attempt < 200 && (!activeHook || !hookCall); attempt++) {
      activeHook = service.listDeployments(owner.id, workspace).find((run) => run.planId === cancelHookPlan.id);
      if (!activeHook || !hookCall) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert(activeHook?.status === 'deploying' && hookCall, 'Active hook deployment did not reach the pinned request for cancellation.');
    await service.cancelDeployment(owner.id, activeHook.id);
    const cancelledHook = await pendingHook;
    assert(cancelledHook.status === 'cancelled' && hookCall.request.destroyed, 'Deploy-hook cancellation did not destroy the secret-bearing pinned request.');
  } finally {
    await service.stopAllDeployments();
    failureCleanups.delete(deploymentCleanup);
  }
}

function validateProjectIntelligenceHonesty() {
  // Accessibility: an empty scan is "not assessed", never a perfect score.
  const a11y = load('apps/desktop/src/common/a11yAudit.ts');
  const emptyA11y = a11y.auditComponents([]);
  assert(
    emptyA11y.assessed === false && emptyA11y.score === null,
    'Empty accessibility scan must report unassessed, not a score.',
  );
  assert(
    a11y.formatA11ySummary(emptyA11y).toLowerCase().includes('not assessed'),
    'Empty accessibility summary must state it was not assessed.',
  );
  const assessedA11y = a11y.auditComponents([
    { id: 'go', interactive: true, role: 'button', name: 'Go' },
  ]);
  assert(
    assessedA11y.assessed === true && assessedA11y.score === 100,
    'A clean assessed accessibility scan should score 100.',
  );

  // Codebase health: zero signals is only healthy for the kinds actually scanned.
  const health = load('apps/desktop/src/common/codebaseHealth.ts');
  const emptyHealth = health.aggregateHealth([]);
  assert(
    emptyHealth.assessed === false && emptyHealth.score === null,
    'Health with no scans must be unassessed, not 100/100.',
  );
  const scannedHealth = health.aggregateHealth([], ['security']);
  assert(
    scannedHealth.assessed === true &&
      scannedHealth.score === 100 &&
      scannedHealth.assessedKinds.includes('security'),
    'A completed clean scan should report a scored, covered health result.',
  );

  // GA gate: all-skipped is no-go; an unevaluated blocker cannot be a clean go.
  const ga = load('apps/desktop/src/common/gaGate.ts');
  const allSkipped = ga.evaluateGaGate([
    { category: 'security', label: 'Secret scan', status: 'skip' },
    { category: 'tests', label: 'Tests', status: 'skip' },
  ]);
  assert(
    allSkipped.verdict === 'no-go' && allSkipped.evaluated === 0,
    'A GA gate with no evaluated checks must be no-go.',
  );
  const skippedBlocker = ga.evaluateGaGate([
    { category: 'performance', label: 'Perf', status: 'pass' },
    { category: 'security', label: 'Secret scan', status: 'skip' },
  ]);
  assert(
    skippedBlocker.verdict === 'conditional' && skippedBlocker.skippedBlockers.length === 1,
    'An unevaluated blocker must prevent a clean go.',
  );
  const cleanGo = ga.evaluateGaGate([
    { category: 'security', label: 'Secret scan', status: 'pass' },
    { category: 'tests', label: 'Tests', status: 'pass' },
    { category: 'stability', label: 'Health', status: 'pass' },
  ]);
  assert(cleanGo.verdict === 'go', 'A fully-evaluated passing blocker set should be go.');

  // RLS: descriptors are parsed from real SQL, not a fixture.
  const rls = load('apps/desktop/src/common/rlsAudit.ts');
  const parsed = rls.parseRlsSchema(
    'create table public.notes (id uuid);\n' +
      'alter table public.notes enable row level security;\n' +
      'create policy "owner_all" on public.notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);\n' +
      'create table public.wide (id uuid);\n' +
      'alter table public.wide enable row level security;\n' +
      'create policy "wide_read" on public.wide for select using (true);\n',
  );
  assert(parsed.length === 2, 'SQL-to-RLS parsing did not discover both tables.');
  const audited = rls.auditRls(parsed);
  assert(
    audited.findings.some((f) => f.table === 'wide'),
    'RLS audit missed a non-user-scoped policy parsed from SQL.',
  );
  assert(rls.parseRlsSchema('select 1;').length === 0, 'RLS parsing invented tables.');

  // Egress: endpoints are discovered from workspace text; plain HTTP is flagged.
  const egress = load('apps/desktop/src/common/egressReview.ts');
  const endpoints = egress.discoverEgressEndpoints(
    'fetch("https://api.example.com/v1"); img.src="http://cdn.test/logo.png";',
  );
  assert(
    endpoints.some((e) => e.host === 'api.example.com' && e.protocol === 'https') &&
      endpoints.some((e) => e.host === 'cdn.test' && e.protocol === 'http'),
    'Egress discovery missed workspace URLs.',
  );
  assert(egress.reviewEgress(endpoints).verdict === 'fail', 'Plain-HTTP discovered egress was not flagged.');
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'axiom-god-mode-'));
  try {
    await validatePureContracts();
    await validateContextService();
    await validateContextBuilderPaths(tempRoot);
    await validateAiReadinessParity();
    await validatePredictiveService();
    await validateWorkspaceTrustRevocation(tempRoot);
    await validateVerificationService(tempRoot);
    await validateIsolatedWorkspaces(tempRoot);
    await validateGithubApiTransport();
    await validateDebugEvidence();
    await validateDurableJobs(tempRoot);
    await validateExtensionAdversaries(tempRoot);
    await validateCollaboration(tempRoot);
    await validateDeployment(tempRoot);
    validateProjectIntelligenceHonesty();
    validateStructuralBoundaries();
    console.log('God Mode validation passed: 10 capability domains, adversarial sandbox cases, and Main/renderer boundaries verified.');
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  await Promise.allSettled([...failureCleanups].map((cleanup) => cleanup()));
  process.exitCode = 1;
});
