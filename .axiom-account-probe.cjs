#!/usr/bin/env node
/**
 * Verification probe for per-account data isolation and the sign-in gate.
 *
 * The load-bearing claim is: "signing in as a different Google account never shows the
 * previous account's work." That rests on three things, each asserted here:
 *
 *   1. userData is repointed at a per-account directory BEFORE any store is read.
 *   2. Only the two things that must survive the repoint (the session and the pointer)
 *      escape it — nothing else may reach the unmovable root.
 *   3. Every store that existed before isolation is adopted by the first real account,
 *      so upgrading does not look like data loss.
 *
 * Check 3 is the one that catches human error: it scans the services for every
 * userData filename they actually use and fails if any is missing from the migration
 * allowlist. Adding a new store without adding it to the list breaks this probe rather
 * than silently stranding that store's history on upgrade.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}
function read(rel) {
  return fs.readFileSync(path.join('apps', 'desktop', rel), 'utf8');
}

// --- Load accountProfile for real, with Electron stubbed --------------------
function loadWithElectronStub(rel) {
  const file = path.join('apps', 'desktop', rel);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  const stubDir = path.resolve('.axiom-probe-stubs');
  fs.mkdirSync(stubDir, { recursive: true });
  const electronStub = path.join(stubDir, 'electron.cjs');
  fs.writeFileSync(
    electronStub,
    "module.exports = { app: { getPath: () => require('os').tmpdir(), setPath: () => undefined, getVersion: () => '0.0.0', relaunch: () => undefined, quit: () => undefined } };\n",
  );
  const sharedStub = path.join(stubDir, 'shared.cjs');
  fs.writeFileSync(
    sharedStub,
    'const noop = () => undefined;\nconst child = { info: noop, warn: noop, debug: noop, error: noop, child: () => child };\nmodule.exports = { rootLogger: child };\n',
  );
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return originalLoad.call(this, electronStub, parent, isMain);
    if (request === '@axiom/shared') return originalLoad.call(this, sharedStub, parent, isMain);
    if (request.startsWith('../../common/')) return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const wrapper = new Module(path.resolve(file), null);
    wrapper.filename = path.resolve(file);
    wrapper.paths = Module._nodeModulePaths(path.dirname(path.resolve(file)));
    wrapper._compile(js, wrapper.filename);
    return wrapper.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const profile = loadWithElectronStub('src/main/services/accountProfile.ts');

// --- 1. Profile keys --------------------------------------------------------
const keyA = profile.profileKeyForUserId('11111111-2222-3333-4444-555555555555');
const keyB = profile.profileKeyForUserId('99999999-8888-7777-6666-555555555555');
check('a signed-in account gets a 32-hex directory key', /^[0-9a-f]{32}$/.test(keyA), keyA);
check('the key is stable for the same user', keyA === profile.profileKeyForUserId('11111111-2222-3333-4444-555555555555'));
check('different accounts get different keys', keyA !== keyB);
check('a missing user falls back to the guest profile', profile.profileKeyForUserId(null) === 'guest');
check('an empty user id is treated as signed out', profile.profileKeyForUserId('   ') === 'guest');
check(
  'the key does not contain the user id',
  !keyA.includes('11111111') && !keyA.includes('2222'),
);

const accountSource = read('src/main/services/accountProfile.ts');
check(
  'the key is salted rather than a bare digest of the id',
  accountSource.includes('axiom-account-profile:'),
);
check(
  'a tampered pointer cannot aim userData outside the profiles directory',
  /value === GUEST_KEY \|\| \/\^\[0-9a-f\]\{32\}\$\/\.test\(value\)/.test(accountSource),
);
check(
  'the pointer is only honoured after that check',
  accountSource.indexOf('if (!isSafeProfileKey(record.accountKey)) return null;') > 0,
);
check('the pointer is written atomically', /writeFileSync\(temporary,[\s\S]{0,200}renameSync\(temporary, target\)/.test(accountSource));

// --- 2. Ordering: bind before anything reads a store ------------------------
const indexSource = read('src/main/index.ts');
const captureIndex = indexSource.indexOf('captureRootUserData();');
const bindIndex = indexSource.indexOf('bindActiveProfile();');
const readyIndex = indexSource.indexOf('app.whenReady()');
check('the real userData root is captured first', captureIndex > 0);
check('the profile is bound after capture', bindIndex > captureIndex);
check('the profile is bound before app ready', bindIndex < readyIndex, `bind=${bindIndex} ready=${readyIndex}`);
check(
  'binding happens only in the instance that won the single-instance lock',
  indexSource.indexOf('if (!gotLock)') < captureIndex,
);

// --- 3. Only the session and the pointer escape the profile -----------------
const servicesDir = path.join('apps', 'desktop', 'src', 'main', 'services');
const rootEscapes = [];
for (const name of fs.readdirSync(servicesDir)) {
  if (!name.endsWith('.ts')) continue;
  const source = fs.readFileSync(path.join(servicesDir, name), 'utf8');
  if (source.includes('rootUserDataPath')) rootEscapes.push(name);
}
rootEscapes.sort();
check(
  'only the auth store and the profile module reach the unmovable root',
  rootEscapes.length === 2 &&
    rootEscapes.includes('accountProfile.ts') &&
    rootEscapes.includes('authStore.ts'),
  rootEscapes.join(', '),
);
const authStoreSource = read('src/main/services/authStore.ts');
check(
  'the auth store no longer resolves through the redirected userData path',
  !authStoreSource.includes("app.getPath('userData')") &&
    authStoreSource.includes("join(rootUserDataPath(), 'auth-store.enc')"),
);

// --- 4. Every pre-isolation store is adopted on upgrade --------------------
const allowlistMatch = /const LEGACY_ENTRIES: readonly string\[\] = \[([\s\S]*?)\];/.exec(accountSource);
check('the migration allowlist is declared', Boolean(allowlistMatch));
const allowlist = new Set(
  (allowlistMatch ? allowlistMatch[1] : '').match(/'([^']+)'/g)?.map((raw) => raw.slice(1, -1)) ?? [],
);
const declared = new Map();
for (const name of fs.readdirSync(servicesDir)) {
  if (!name.endsWith('.ts')) continue;
  const source = fs.readFileSync(path.join(servicesDir, name), 'utf8');
  const pattern = /getPath\('userData'\),\s*'([^']+)'/g;
  let hit;
  while ((hit = pattern.exec(source)) !== null) {
    declared.set(hit[1], name);
  }
  // Names held in a constant, e.g. `join(app.getPath('userData'), FILE)`.
  const viaConstant = /getPath\('userData'\),\s*([A-Z_]+)\)/g;
  while ((hit = viaConstant.exec(source)) !== null) {
    const constant = new RegExp(`const ${hit[1]} = '([^']+)'`).exec(source);
    if (constant) declared.set(constant[1], name);
  }
}
/**
 * Names that are deliberately NOT adopted, with the reason. A store may only appear
 * here because it holds nothing an account would miss — anything else must be in the
 * allowlist so an upgrade does not look like data loss.
 */
const NOT_ADOPTED = new Map([
  ['updates', 're-downloadable installer cache, not account history'],
  ['extension-registry', 'public marketplace metadata cache, refetchable on demand'],
]);
const missing = [...declared.keys()]
  .filter((name) => !allowlist.has(name) && !NOT_ADOPTED.has(name))
  .sort();
check(
  'every store filename the services use is in the migration allowlist',
  missing.length === 0,
  missing.length > 0 ? missing.map((n) => `${n} (${declared.get(n)})`).join(', ') : `${declared.size} names covered`,
);
const contradictions = [...NOT_ADOPTED.keys()].filter((name) => allowlist.has(name));
check(
  'nothing is both adopted and declared transient',
  contradictions.length === 0,
  contradictions.join(', '),
);
check(
  'each exclusion is justified in the module itself',
  [...NOT_ADOPTED.keys()].every((name) => new RegExp(`\`${name}/\``).test(accountSource)),
);
check(
  'Electron-owned directories are NOT adopted',
  !allowlist.has('Cache') && !allowlist.has('GPUCache') && !allowlist.has('Local Storage'),
);
check('the auth store is never adopted into a profile', !allowlist.has('auth-store.enc'));
check(
  'adoption is skipped for the guest profile',
  accountSource.includes("if (key !== GUEST_KEY) adoptLegacyData(directory);"),
);
check(
  'adoption never overwrites newer per-account state',
  accountSource.includes('if (!existsSync(from) || existsSync(to)) continue;'),
);
check('adoption runs at most once per profile', accountSource.includes('ADOPTION_MARKER'));

// --- 5. Account switching -------------------------------------------------
const sessionSource = read('src/main/services/sessionManager.ts');
check(
  'auth state is reconciled against the bound profile before it is published',
  /function publish\(state: AuthState\): void \{[\s\S]{0,400}reconcileActiveAccount\(/.test(sessionSource),
);
const broadcastCalls = (sessionSource.match(/^\s*broadcast\(/gm) || []).length;
check(
  'every auth transition goes through publish, not a bare broadcast',
  broadcastCalls === 2,
  `${broadcastCalls} direct broadcast call(s) — expected the two inside publish()`,
);
check(
  'a different account restarts AXIOM',
  sessionSource.includes('app.relaunch();') && sessionSource.includes('app.quit();'),
);
check(
  'the restart uses quit so unsaved editors still prompt',
  !sessionSource.includes('app.exit('),
);
check('a second relaunch cannot be queued', sessionSource.includes('if (relaunching) return;'));
check(
  'signing out records the intent without restarting',
  accountSource.includes("return userId === null ? 'unchanged' : 'relaunch';"),
);
check(
  'signing back into the same account repairs the pointer',
  /if \(pointer\?\.accountKey !== desired\) \{[\s\S]{0,160}writePointer\(/.test(accountSource),
);

// --- 6. The gate ---------------------------------------------------------
const app = read('src/renderer/src/App.tsx');
check('the workbench is gated on being signed in', app.includes("if (status !== 'signedIn') return <SignInGate />;"));
check('a resolving session shows a neutral screen', app.includes("if (status === 'loading') return <SignInLoading />;"));
check(
  'MainApp is not rendered behind the gate',
  /function AuthGate\(\)[\s\S]{0,400}return <MainApp \/>;/.test(app) &&
    !/<AuthProvider>\s*<MainApp \/>/.test(app),
);
const gate = read('src/renderer/src/workbench/SignInGate.tsx');
check('the gate cannot be dismissed', !gate.includes('onClose'));
check(
  'the gate explains why sign-in is required',
  gate.includes('stored separately for each account'),
);

// --- 7. The profile panel -------------------------------------------------
const profileView = read('src/renderer/src/workbench/ProfileView.tsx');
check('the profile panel shows the email', profileView.includes('{user.email}'));
check('the profile panel shows the name', profileView.includes('profile-name'));
check('the profile panel offers sign out', profileView.includes('Sign out'));
check(
  'the profile panel closes itself once signed out',
  profileView.includes("if (status === 'signedOut') onClose();"),
);
check(
  'the profile summary carries no path, email or user id from Main',
  !accountSource.includes('directory,\n    entries') &&
    /reference: key === GUEST_KEY \? GUEST_KEY : key\.slice\(0, 8\)/.test(accountSource),
);
const accountButton = read('src/renderer/src/workbench/AccountButton.tsx');
check('the account menu opens the profile', accountButton.includes("label: 'Your Profile…'"));

try {
  fs.rmSync(path.resolve('.axiom-probe-stubs'), { recursive: true, force: true });
} catch {
  // Leaving the stub directory behind is harmless.
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `FAILURES ${failures}`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
