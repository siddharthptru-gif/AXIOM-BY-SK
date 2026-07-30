import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { rootLogger } from '@axiom/shared';
import { buildChildProcessEnvironment } from './processEnvironment';
import type {
  ExecutionConsentSource,
  ExecutionConsentState,
} from '../../common/executionConsentTypes';

export type { ExecutionConsentSource, ExecutionConsentState };

/**
 * Build execution consent.
 *
 * AXIOM used to ask twice for one action: an in-app card showing the exact change,
 * and then a second OS-drawn dialog repeating the same question. Two confirmations
 * for one decision is not twice the safety — it trains people to click through both
 * without reading, and cancelling the second one left the action permanently
 * rejected with no way back, so the user was stuck clicking buttons that could
 * never succeed.
 *
 * The consent is collected ONCE, at install time, and recorded where the renderer
 * cannot reach it. After that the in-app card is the single decision point.
 *
 * What this deliberately does NOT change:
 *
 * - Workspace trust. Restricted Mode still blocks every mutation and every command;
 *   consent authorizes nothing outside a folder the user explicitly trusted.
 * - Root containment, path canonicalization, command bounds, diff integrity, and the
 *   audit digest. Every one of those checks still runs on every action.
 * - The exact preview. The user still sees the precise diff or command before
 *   deciding; only the duplicate second question is gone.
 *
 * What it does change, stated plainly: the OS-drawn dialog was the one confirmation a
 * compromised renderer could not fabricate. Moving that decision to install time
 * trades that specific defence for a single, comprehensible prompt — the same trade
 * every platform makes when it grants an application its permissions up front.
 */
const log = rootLogger.child('execution-consent');

/** Written by the installer's permission step; never written by the renderer. */
const WINDOWS_CONSENT_KEY = 'HKCU\\Software\\AXIOM\\Setup';
const WINDOWS_CONSENT_VALUE = 'BuildExecutionConsent';
const CONSENT_FILE = 'execution-consent.json';
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_CAP = 4_000;

let cache: ExecutionConsentState | null = null;
let inFlight: Promise<ExecutionConsentState> | null = null;

function consentFilePath(): string {
  return join(app.getPath('userData'), CONSENT_FILE);
}

/** Run a short read-only command by absolute path, with no shell. */
function runCapture(executable: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        env: buildChildProcessEnvironment({ color: false }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    let settled = false;
    let failed = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      resolve(failed ? null : output);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish();
    }, PROBE_TIMEOUT_MS);
    const append = (chunk: Buffer): void => {
      if (output.length < PROBE_OUTPUT_CAP) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', () => {
      failed = true;
      finish();
    });
    child.on('close', finish);
  });
}

/** True when the installer recorded the permission for this user. */
async function readInstallerGrant(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? process.env.windir;
  if (!systemRoot) return false;
  const reg = join(systemRoot, 'System32', 'reg.exe');
  if (!existsSync(reg)) return false;
  const output = await runCapture(reg, ['query', WINDOWS_CONSENT_KEY, '/v', WINDOWS_CONSENT_VALUE]);
  if (output === null) return false;
  // `reg query` prints `BuildExecutionConsent    REG_DWORD    0x1`.
  const match = new RegExp(`${WINDOWS_CONSENT_VALUE}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(
    output,
  );
  return match ? Number.parseInt(match[1] ?? '0', 16) === 1 : false;
}

/** The user's own in-app decision, which overrides the installer default. */
async function readStoredGrant(): Promise<ExecutionConsentState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(consentFilePath(), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.granted !== 'boolean') return null;
    const source: ExecutionConsentSource = record.source === 'installer' ? 'installer' : 'in-app';
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : null;
    return { granted: record.granted, source: record.granted ? source : 'none', at };
  } catch {
    return null;
  }
}

async function persist(state: ExecutionConsentState): Promise<void> {
  const target = consentFilePath();
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/**
 * The current consent, cached for the process lifetime.
 *
 * A stored in-app decision wins, so revoking inside AXIOM takes effect even though
 * the installer granted it. Otherwise the installer's record decides.
 */
export function loadExecutionConsent(): Promise<ExecutionConsentState> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<ExecutionConsentState> => {
    const stored = await readStoredGrant().catch(() => null);
    if (stored) return stored;
    const installer = await readInstallerGrant().catch(() => false);
    return installer
      ? { granted: true, source: 'installer', at: null }
      : { granted: false, source: 'none', at: null };
  })()
    .then((state) => {
      cache = state;
      log.info('Build execution consent resolved', {
        granted: state.granted,
        source: state.source,
      });
      return state;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** True when the in-app decision alone is enough to authorize an approved action. */
export async function hasExecutionConsent(): Promise<boolean> {
  const state = await loadExecutionConsent().catch(() => null);
  return state?.granted === true;
}

/**
 * Record the user's own decision. Called only from a Main IPC handler, so the value
 * is never written from renderer state directly.
 */
export async function setExecutionConsent(granted: boolean): Promise<ExecutionConsentState> {
  const state: ExecutionConsentState = {
    granted,
    source: granted ? 'in-app' : 'none',
    at: Date.now(),
  };
  await persist(state);
  cache = state;
  log.info('Build execution consent changed', { granted });
  return state;
}

/** Resolve consent during startup so the first approval does not wait on a probe. */
export function warmExecutionConsent(): void {
  void loadExecutionConsent().catch((error: unknown) => {
    log.warn('Could not resolve Build execution consent', {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}
