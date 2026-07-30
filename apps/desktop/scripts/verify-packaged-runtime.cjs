'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const {
  FUSE_POLICY,
  assertPackagedAsarPolicy,
  assertFuseWire,
  hashAsarHeader,
  updateWindowsIntegrityResource,
  windowsIntegrityPayload,
} = require('./after-pack-fuses.cjs');

const MAX_APP_DIR_CHARS = 1024;
const MAX_SMOKE_OUTPUT_BYTES = 64 * 1024;
const SMOKE_TIMEOUT_MS = 20_000;
const RENDERER_SMOKE_TIMEOUT_MS = 30_000;
const MIN_RENDERER_SCREENSHOT_BYTES = 8 * 1024;
const RENDERER_ENTRY_URL = 'axiom://renderer/index.html';
// Electron's Windows GUI entry point writes this prefix before Main runs whenever
// stdout is redirected: https://github.com/electron/electron/issues/12578
// Keep the smoke comparison byte-exact; never trim or otherwise normalize it.
const ELECTRON_WINDOWS_STDOUT_PREFIX = '\r\n';
const desktopVersion = require('../package.json').version;
if (typeof desktopVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(desktopVersion)) {
  throw new Error('Desktop package version must be a stable semantic version.');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function smoke(executable) {
  await new Promise((resolve, reject) => {
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT']) {
      if (typeof process.env[name] === 'string') env[name] = process.env[name];
    }
    const child = spawn(executable, ['--version'], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let outputExceeded = false;
    const collect = (target) => (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_SMOKE_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Packaged launch smoke timed out.'));
    }, SMOKE_TIMEOUT_MS);
    child.once('error', finish);
    child.once('close', (code) => {
      if (outputExceeded) {
        finish(new Error('Packaged launch smoke exceeded its output limit.'));
        return;
      }
      if (code !== 0) {
        finish(new Error(`Packaged launch smoke exited ${String(code)}.`));
        return;
      }
      const actualStdout = Buffer.concat(stdout).toString('utf8');
      const actualStderr = Buffer.concat(stderr).toString('utf8');
      const expectedStdout = `${ELECTRON_WINDOWS_STDOUT_PREFIX}${desktopVersion}\n`;
      if (actualStdout !== expectedStdout || actualStderr !== '') {
        finish(new Error('Packaged --version output did not exactly match the desktop version.'));
        return;
      }
      finish();
    });
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Could not reserve a bounded renderer-smoke port.');
  }
  return port;
}

async function waitForRendererTarget(port, child) {
  const deadline = Date.now() + RENDERER_SMOKE_TIMEOUT_MS;
  let targetSummary = 'none';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged renderer exited before paint (${String(child.exitCode)}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets)) {
          targetSummary = JSON.stringify(
            targets.slice(0, 8).map((target) => ({ type: target.type, url: target.url })),
          );
          const page = targets.find(
            (target) => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
          );
          if (page) return page.webSocketDebuggerUrl;
        }
      }
    } catch {
      // The loopback DevTools endpoint is not ready yet.
    }
    await wait(200);
  }
  throw new Error(`Packaged renderer target did not appear: ${targetSummary}`);
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url, { maxPayload: 16 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.on('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Renderer DevTools connection closed.'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Renderer DevTools connection is unavailable.'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || typeof child.pid !== 'number') return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) await wait(50);
  if (child.exitCode === null) child.kill();
}

async function removeTemporaryProfile(profile) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(profile, { recursive: true, force: true });
      return;
    } catch {
      await wait(100 * (attempt + 1));
    }
  }
  throw new Error('Could not remove the temporary renderer-smoke profile.');
}

async function smokeRenderer(executable) {
  const port = await reserveLoopbackPort();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-renderer-smoke-'));
  const env = {};
  for (const name of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'PATH',
    'PATHEXT',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
  ]) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  const child = spawn(
    executable,
    [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
    ],
    {
      cwd: path.dirname(executable),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let outputBytes = 0;
  let outputExceeded = false;
  const collect = (chunk) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_SMOKE_OUTPUT_BYTES) outputExceeded = true;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let cdp;
  try {
    const targetUrl = await waitForRendererTarget(port, child);
    cdp = new CdpSession(targetUrl);
    await cdp.open();
    await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable')]);
    const deadline = Date.now() + RENDERER_SMOKE_TIMEOUT_MS;
    let state;
    while (Date.now() < deadline) {
      const evaluation = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const root = document.getElementById('root');
          const bodyText = document.body ? document.body.innerText.slice(0, 512) : '';
          return {
            href: location.href,
            readyState: document.readyState,
            bridge: typeof window.axiom,
            rootChildren: root ? root.childElementCount : -1,
            workbench: Boolean(document.querySelector('.workbench')),
            recovery: bodyText.includes('Axiom needs to reload'),
            visibleText: /\\S/.test(bodyText),
          };
        })()`,
        returnByValue: true,
      });
      state = evaluation?.result?.value;
      if (
        state?.href === RENDERER_ENTRY_URL &&
        state.readyState === 'complete' &&
        state.bridge === 'object' &&
        state.rootChildren > 0 &&
        state.workbench === true &&
        state.recovery === false &&
        state.visibleText === true
      ) {
        break;
      }
      await wait(200);
    }
    if (
      state?.href !== RENDERER_ENTRY_URL ||
      state.readyState !== 'complete' ||
      state.bridge !== 'object' ||
      state.rootChildren <= 0 ||
      state.workbench !== true ||
      state.recovery !== false ||
      state.visibleText !== true
    ) {
      throw new Error(`Packaged renderer did not mount the workbench: ${JSON.stringify(state)}`);
    }
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const screenshotBytes = Buffer.from(capture?.data ?? '', 'base64');
    if (screenshotBytes.length < MIN_RENDERER_SCREENSHOT_BYTES) {
      throw new Error(
        `Packaged renderer screenshot is blank or incomplete (${screenshotBytes.length} bytes).`,
      );
    }
    if (outputExceeded) throw new Error('Packaged renderer smoke exceeded its output limit.');
  } finally {
    cdp?.close();
    await stopProcessTree(child);
    await removeTemporaryProfile(profile);
  }
}

async function verifyPackagedRuntime(appDir) {
  if (process.platform !== 'win32') {
    throw new Error('Packaged Windows runtime verification requires Windows.');
  }
  if (typeof appDir !== 'string' || appDir.length === 0 || appDir.length > MAX_APP_DIR_CHARS) {
    throw new Error('A bounded packaged app directory is required.');
  }
  const root = await fs.realpath(path.resolve(appDir));
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Packaged app directory must be a regular non-reparse directory.');
  }
  const executable = path.join(root, 'AXIOM.exe');
  const asar = path.join(root, 'resources', 'app.asar');
  for (const candidate of [executable, asar]) {
    const candidateStat = await fs.lstat(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw new Error(`Packaged runtime file is unsafe: ${path.basename(candidate)}`);
    }
  }
  await assertPackagedAsarPolicy(asar, `${asar}.unpacked`);
  const payload = windowsIntegrityPayload(await hashAsarHeader(asar));
  await updateWindowsIntegrityResource(executable, payload, 'verify');
  const fuses = await import('@electron/fuses');
  const actual = await fuses.getCurrentFuseWire(executable);
  assertFuseWire(actual, fuses);
  await smoke(executable);
  await smokeRenderer(executable);
  console.log(
    `[release-hardening] Post-sign ASAR inventory, ELECTRONASAR resource, ${Object.keys(FUSE_POLICY).length} fuses, exact version launch, and renderer paint smoke passed.`,
  );
}

if (require.main === module) {
  verifyPackagedRuntime(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { smokeRenderer, verifyPackagedRuntime };
