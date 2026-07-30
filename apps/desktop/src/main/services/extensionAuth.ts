import { app } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { rootLogger } from '@axiom/shared';
import {
  MAX_AUTH_PROVIDERS_PER_EXTENSION,
  normalizeScopes,
  parseSession,
  parseSessionList,
  scopeKey,
  selectSession,
  sessionSatisfies,
  type AuthAccount,
  type AuthProviderInfo,
  type AuthSession,
} from '../../common/vscodeAuth';
import { getGithubCredentialSnapshot } from './githubScm';

/**
 * `vscode.authentication` — who may sign in, with what, and on whose behalf.
 *
 * Three kinds of participant meet here and none of them trusts the others:
 *
 *   - **Extensions that ask for a session.** They call `getSession('github', ['repo'])` on
 *     nearly every activation. What they get back is a real access token, so the question of
 *     whether *this* extension may have *that* account's token is answered by the user, once
 *     per extension and scope set, and then remembered.
 *   - **Extensions that provide sessions.** `registerAuthenticationProvider` makes an
 *     extension the authority for a provider id. Its answers are extension output: parsed,
 *     bounded, and dropped if malformed rather than forwarded as a bearer credential.
 *   - **AXIOM itself.** The built-in `github` provider is the credential Axiom's own Source
 *     Control sign-in already established. It is reused rather than re-obtained, because the
 *     brief is explicit that extensions must not each grow their own login window, and because
 *     a second GitHub token for the same user is a second thing to leak.
 *
 * Deliberate non-goals. Nothing here mints a token, runs an OAuth exchange, or stores a
 * provider's refresh token: extension providers do their own round trips (through
 * `asExternalUri`, see `extensionUri.ts`) and AXIOM's own flows stay where they are. This file
 * is the broker and the consent ledger, not a second identity system.
 */
const log = rootLogger.child('extension-auth');

/** How long AXIOM waits for Axiom's own GitHub sign-in to complete before giving up. */
const CONNECT_TIMEOUT_MS = 3 * 60 * 1000;
/** How often the built-in provider re-checks whether the sign-in finished. */
const CONNECT_POLL_MS = 1_000;
/** The one session id the built-in provider ever reports. */
const BUILTIN_GITHUB_SESSION = 'axiom-github';

// ---------------------------------------------------------------------------
// The bridge back to the host supervisor
// ---------------------------------------------------------------------------
/**
 * What this broker needs from `marketplaceHost`, injected rather than imported.
 *
 * The supervisor already imports this file to answer requests, so importing it back would be a
 * cycle. Naming the four things needed also keeps the seam testable: everything below is
 * reachable without an Electron window.
 */
export interface AuthHostBridge {
  /** Ask the user a question on an extension's behalf. Resolves null when dismissed. */
  askUser(extensionId: string, message: string, items: string[]): Promise<string | null>;
  /** Call an extension's registered provider and wait for its answer. */
  callProvider(
    extensionId: string,
    providerId: string,
    op: 'getSessions' | 'createSession' | 'removeSession',
    scopes: string[],
    sessionId: string | null,
  ): Promise<unknown>;
  /** Tell every running host that one provider's sessions changed. */
  notifySessionsChanged(providerId: string): void;
  /** Fire `onAuthenticationRequest:<id>` so a provider extension can register itself. */
  activateProvider(providerId: string): Promise<void>;
  /** Run one of AXIOM's own workbench commands, e.g. the existing GitHub sign-in. */
  runWorkbenchCommand(command: string): void;
}

let bridge: AuthHostBridge | null = null;

export function configureExtensionAuth(next: AuthHostBridge): void {
  bridge = next;
}

function requireBridge(): AuthHostBridge {
  if (bridge === null) throw new Error('The extension authentication broker is not configured.');
  return bridge;
}

// ---------------------------------------------------------------------------
// The consent ledger
// ---------------------------------------------------------------------------
/**
 * Which extension may use which provider, for which scopes.
 *
 * Persisted in plain JSON, deliberately: it holds no secrets, only decisions, and a decision
 * the user can read in a file is a decision the user can revoke with a text editor. It is
 * separate from the encrypted secret store for the same reason — nothing here is worth
 * decrypting, and mixing the two would mean a grant lookup needs the OS keychain.
 *
 * A grant is recorded against the *normalized scope set* that was asked for. A stored grant
 * covers any request whose scopes it contains: an extension the user allowed for
 * `['repo','read:user']` does not re-prompt when it later asks for `['read:user']`, which is
 * the same superset rule `sessionSatisfies` applies to sessions.
 */
type GrantTable = Map<string, Map<string, Set<string>>>;

const grants: GrantTable = new Map();
let grantsLoaded = false;

function grantsPath(): string {
  return join(app.getPath('userData'), 'extension-auth-grants.json');
}

async function loadGrants(): Promise<void> {
  if (grantsLoaded) return;
  grantsLoaded = true;
  let text: string;
  try {
    text = await readFile(grantsPath(), 'utf-8');
  } catch {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [extensionId, providers] of Object.entries(parsed as Record<string, unknown>)) {
      if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue;
      const perProvider = new Map<string, Set<string>>();
      for (const [providerId, keys] of Object.entries(providers as Record<string, unknown>)) {
        if (!Array.isArray(keys)) continue;
        perProvider.set(
          providerId,
          new Set(keys.filter((key): key is string => typeof key === 'string').slice(0, 64)),
        );
      }
      grants.set(extensionId.toLowerCase(), perProvider);
    }
  } catch {
    // A grant file that will not parse is a grant file that grants nothing. Starting from
    // "ask again" is the safe direction: the user is re-prompted rather than silently treated
    // as having consented to something unreadable.
    log.warn('The extension authentication grant file was unreadable and was ignored');
  }
}

async function saveGrants(): Promise<void> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [extensionId, providers] of grants) {
    const perProvider: Record<string, string[]> = {};
    for (const [providerId, keys] of providers) {
      if (keys.size > 0) perProvider[providerId] = [...keys];
    }
    if (Object.keys(perProvider).length > 0) out[extensionId] = perProvider;
  }
  const path = grantsPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    '.axiom-ext-grants-' + randomBytes(6).toString('hex') + '.tmp',
  );
  await writeFile(temporary, JSON.stringify(out, null, 2), 'utf-8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function grantCovers(held: Set<string>, requested: readonly string[]): boolean {
  const wanted = new Set(normalizeScopes(requested));
  for (const entry of held) {
    const granted = new Set(entry.length === 0 ? [] : entry.split(' '));
    let covers = true;
    for (const scope of wanted) {
      if (!granted.has(scope)) {
        covers = false;
        break;
      }
    }
    if (covers) return true;
  }
  return false;
}

async function hasGrant(
  extensionId: string,
  providerId: string,
  scopes: readonly string[],
): Promise<boolean> {
  await loadGrants();
  const held = grants.get(extensionId.toLowerCase())?.get(providerId);
  return held !== undefined && grantCovers(held, scopes);
}

async function recordGrant(
  extensionId: string,
  providerId: string,
  scopes: readonly string[],
): Promise<void> {
  await loadGrants();
  const key = extensionId.toLowerCase();
  const perProvider = grants.get(key) ?? new Map<string, Set<string>>();
  const held = perProvider.get(providerId) ?? new Set<string>();
  held.add(scopeKey(scopes));
  perProvider.set(providerId, held);
  grants.set(key, perProvider);
  await saveGrants();
}

/** Forget what one extension was allowed for one provider. Used on sign-out and on request. */
export async function revokeAuthGrant(extensionId: string, providerId: string): Promise<void> {
  await loadGrants();
  const perProvider = grants.get(extensionId.toLowerCase());
  if (perProvider === undefined || !perProvider.delete(providerId)) return;
  await saveGrants();
}

/** Forget everything one extension was allowed. Called when it is uninstalled. */
export async function revokeAllAuthGrants(extensionId: string): Promise<void> {
  await loadGrants();
  if (!grants.delete(extensionId.toLowerCase())) return;
  await saveGrants();
}

// ---------------------------------------------------------------------------
// The built-in provider: Axiom's own GitHub account
// ---------------------------------------------------------------------------
interface Requester {
  extensionId: string;
  displayName: string;
}

interface BuiltInProvider {
  info: AuthProviderInfo;
  getSessions(scopes: readonly string[]): Promise<AuthSession[]>;
  createSession(scopes: readonly string[], requester: Requester): Promise<AuthSession>;
  removeSession(sessionId: string): Promise<void>;
}

function githubSession(access: string, scopes: readonly string[]): AuthSession {
  return {
    id: BUILTIN_GITHUB_SESSION,
    accessToken: access,
    account: { id: 'axiom-github', label: 'GitHub (connected in AXIOM)' },
    scopes: normalizeScopes(scopes),
  };
}

/**
 * `github`, backed by the credential Axiom's Source Control already holds.
 *
 * This exists because upstream ships GitHub authentication as a built-in extension that AXIOM
 * does not have, so `getSession('github', …)` — which a large share of real extensions call —
 * would otherwise fail with "no provider" no matter how correct the rest of this file is. It
 * is not special-casing an extension: any extension asking for the `github` provider id is
 * answered the same way, and an extension that registers its own `github` provider replaces
 * this one (see `resolveProvider`).
 *
 * Sign-in is Axiom's existing flow, driven by running Axiom's own `github.connect` command and
 * waiting for the credential to appear. No login window is built here, and the token is never
 * copied into a second store.
 */
const builtInGithub: BuiltInProvider = {
  info: {
    id: 'github',
    label: 'GitHub',
    extensionId: null,
    supportsMultipleAccounts: false,
  },
  async getSessions(): Promise<AuthSession[]> {
    const snapshot = await getGithubCredentialSnapshot();
    return snapshot === null ? [] : [githubSession(snapshot.access, snapshot.scopes)];
  },
  async createSession(scopes: readonly string[], requester: Requester): Promise<AuthSession> {
    const existing = await getGithubCredentialSnapshot();
    if (existing !== null) {
      // Connected, but not for what was asked. Saying so is the only honest answer: Axiom's
      // sign-in grants a fixed scope set, and re-running it would return the same token.
      throw new Error(
        `The GitHub account connected in AXIOM does not grant ${normalizeScopes(scopes).join(', ')}. ` +
          'Reconnect the account in Source Control if it needs different permissions.',
      );
    }
    const host = requireBridge();
    const answer = await host.askUser(
      requester.extensionId,
      `${requester.displayName} wants to sign in to GitHub. AXIOM will open its own GitHub sign-in, and the extension will receive an access token for the account you connect.`,
      ['Sign in to GitHub', 'Cancel'],
    );
    if (answer !== 'Sign in to GitHub') throw new Error('GitHub sign-in was cancelled.');
    host.runWorkbenchCommand('github.connect');
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, CONNECT_POLL_MS));
      const snapshot = await getGithubCredentialSnapshot();
      if (snapshot === null) continue;
      const session = githubSession(snapshot.access, snapshot.scopes);
      if (!sessionSatisfies(session, scopes)) {
        throw new Error(
          `The GitHub account you connected does not grant ${normalizeScopes(scopes).join(', ')}.`,
        );
      }
      return session;
    }
    throw new Error('GitHub sign-in did not complete in time.');
  },
  async removeSession(): Promise<void> {
    const host = requireBridge();
    // Signing out here disconnects the account Axiom's own Source Control uses, so the user
    // decides rather than the extension. Handing this to the existing disconnect command keeps
    // one code path for forgetting the credential.
    const answer = await host.askUser(
      'github',
      'An extension asked to sign out of GitHub. This disconnects the GitHub account AXIOM uses for Source Control as well.',
      ['Sign out', 'Keep signed in'],
    );
    if (answer !== 'Sign out') throw new Error('Sign-out was declined.');
    host.runWorkbenchCommand('github.disconnect');
  },
};

const builtInProviders = new Map<string, BuiltInProvider>([[builtInGithub.info.id, builtInGithub]]);

// ---------------------------------------------------------------------------
// Providers extensions register
// ---------------------------------------------------------------------------
const registered = new Map<string, AuthProviderInfo>();

/**
 * Record a provider an extension registered.
 *
 * An extension may replace a built-in id. That is not a hole: upstream ships GitHub
 * authentication *as an extension*, so a user who installs the real provider extension must get
 * the real provider rather than AXIOM's stand-in, and refusing the registration would strand
 * every extension that then asks for a session it could have had.
 */
export function registerExtensionAuthProvider(
  extensionId: string,
  info: { providerId: string; label: string; supportsMultipleAccounts: boolean },
): void {
  const owned = [...registered.values()].filter(
    (entry) => entry.extensionId === extensionId.toLowerCase(),
  );
  const existing = registered.get(info.providerId);
  if (existing !== undefined && existing.extensionId !== extensionId.toLowerCase()) {
    throw new Error(`Another extension already provides authentication for ${info.providerId}.`);
  }
  if (existing === undefined && owned.length >= MAX_AUTH_PROVIDERS_PER_EXTENSION) {
    throw new Error('This extension has already registered the maximum number of providers.');
  }
  registered.set(info.providerId, {
    id: info.providerId,
    label: info.label,
    extensionId: extensionId.toLowerCase(),
    supportsMultipleAccounts: info.supportsMultipleAccounts,
  });
  if (builtInProviders.has(info.providerId)) {
    log.info('An extension replaced a built-in authentication provider', {
      providerId: info.providerId,
      extensionId,
    });
  }
  requireBridge().notifySessionsChanged(info.providerId);
}

export function unregisterExtensionAuthProvider(extensionId: string, providerId: string): void {
  const existing = registered.get(providerId);
  if (existing === undefined || existing.extensionId !== extensionId.toLowerCase()) return;
  registered.delete(providerId);
  requireBridge().notifySessionsChanged(providerId);
}

/** Drop every provider one extension registered. Called when its host stops. */
export function clearAuthProvidersForExtension(extensionId: string): void {
  const owner = extensionId.toLowerCase();
  for (const [providerId, info] of [...registered]) {
    if (info.extensionId === owner) registered.delete(providerId);
  }
}

/** Forget every registration. Called when every host is stopped. */
export function resetExtensionAuthState(): void {
  registered.clear();
}

/** Providers available right now, for the extension detail panel. */
export function listAuthProviders(): AuthProviderInfo[] {
  const out = new Map<string, AuthProviderInfo>();
  for (const provider of builtInProviders.values()) out.set(provider.info.id, provider.info);
  for (const [id, info] of registered) out.set(id, info);
  return [...out.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Find who answers for a provider id, activating its extension if it has not started.
 *
 * The activation is the `onAuthenticationRequest:<id>` trigger, and it is why this is async: a
 * provider extension is not running until something asks it for a session, which is exactly the
 * laziness the activation phase is built around. A built-in is only used when no extension
 * claims the id after that chance to register.
 */
async function resolveProvider(
  providerId: string,
): Promise<
  | { kind: 'extension'; info: AuthProviderInfo }
  | { kind: 'builtin'; provider: BuiltInProvider }
  | null
> {
  const claimed = registered.get(providerId);
  if (claimed !== undefined && claimed.extensionId !== null) {
    return { kind: 'extension', info: claimed };
  }
  try {
    await requireBridge().activateProvider(providerId);
  } catch (error) {
    log.warn('Activating an authentication provider failed', {
      providerId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const afterActivation = registered.get(providerId);
  if (afterActivation !== undefined && afterActivation.extensionId !== null) {
    return { kind: 'extension', info: afterActivation };
  }
  const builtIn = builtInProviders.get(providerId);
  return builtIn === undefined ? null : { kind: 'builtin', provider: builtIn };
}

// ---------------------------------------------------------------------------
// What the broker answers
// ---------------------------------------------------------------------------
export interface SessionRequest {
  providerId: string;
  scopes: string[];
  createIfNone: boolean;
  clearSessionPreference: boolean;
  forceNewSession: boolean;
  silent: boolean;
}

type Resolved = Awaited<ReturnType<typeof resolveProvider>>;

async function providerSessions(
  resolved: NonNullable<Resolved>,
  scopes: string[],
): Promise<AuthSession[]> {
  if (resolved.kind === 'builtin') return resolved.provider.getSessions(scopes);
  const extensionId = resolved.info.extensionId;
  if (extensionId === null) return [];
  const raw = await requireBridge().callProvider(
    extensionId,
    resolved.info.id,
    'getSessions',
    scopes,
    null,
  );
  return parseSessionList(raw);
}

async function createProviderSession(
  resolved: NonNullable<Resolved>,
  scopes: string[],
  requester: Requester,
): Promise<AuthSession> {
  if (resolved.kind === 'builtin') return resolved.provider.createSession(scopes, requester);
  const extensionId = resolved.info.extensionId;
  if (extensionId === null) throw new Error('That provider cannot create a session.');
  const raw = await requireBridge().callProvider(
    extensionId,
    resolved.info.id,
    'createSession',
    scopes,
    null,
  );
  const session = parseSession(raw);
  if (session === null) {
    // A provider that returns something unusable is a provider bug, and the extension that
    // asked must not be handed a half-built session it will send to a server as a credential.
    throw new Error(`${resolved.info.label} did not return a usable session.`);
  }
  return session;
}

/**
 * Whether this extension may use this provider for these scopes.
 *
 * The prompt names both sides and says what is handed over, because that is what the user is
 * actually deciding. A `silent` request never prompts — upstream's contract is that silent
 * means "answer from what I already have access to" — so it returns false instead, and the
 * extension shows its own sign-in affordance.
 */
async function ensureGrant(
  requester: Requester,
  provider: AuthProviderInfo,
  scopes: string[],
  silent: boolean,
): Promise<boolean> {
  if (await hasGrant(requester.extensionId, provider.id, scopes)) return true;
  if (silent) return false;
  const detail =
    scopes.length === 0 ? 'your account' : `your account with access to: ${scopes.join(', ')}`;
  const answer = await requireBridge().askUser(
    requester.extensionId,
    `${requester.displayName} wants to sign in using ${provider.label}. If you allow it, the extension receives an access token for ${detail}.`,
    ['Allow', 'Deny'],
  );
  if (answer !== 'Allow') return false;
  await recordGrant(requester.extensionId, provider.id, scopes);
  return true;
}

function providerInfoOf(resolved: NonNullable<Resolved>): AuthProviderInfo {
  return resolved.kind === 'builtin' ? resolved.provider.info : resolved.info;
}

/**
 * `authentication.getSession`.
 *
 * Ordered so that the cheapest honest answer wins: an existing session the extension is already
 * allowed to use costs one provider call and no prompt, which matters because this runs on
 * nearly every activation of every authenticating extension.
 */
export async function getSessionForExtension(
  requester: Requester,
  request: SessionRequest,
): Promise<AuthSession | null> {
  const resolved = await resolveProvider(request.providerId);
  if (resolved === null) {
    if (!request.createIfNone && !request.forceNewSession) return null;
    throw new Error(`No authentication provider is registered for ${request.providerId}.`);
  }
  const info = providerInfoOf(resolved);
  const scopes = normalizeScopes(request.scopes);
  if (request.clearSessionPreference) {
    await revokeAuthGrant(requester.extensionId, info.id);
  }

  if (!request.forceNewSession) {
    const existing = selectSession(await providerSessions(resolved, scopes), scopes);
    if (existing !== null) {
      return (await ensureGrant(requester, info, scopes, request.silent)) ? existing : null;
    }
  }
  if (!request.createIfNone && !request.forceNewSession) return null;
  if (request.silent) return null;
  if (!(await ensureGrant(requester, info, scopes, false))) {
    // Upstream throws when a `createIfNone` request is refused, and extensions handle it: a
    // thrown "not consented" is distinguishable from "signed in but no session", a null is not.
    throw new Error(`${requester.displayName} was not allowed to sign in using ${info.label}.`);
  }
  const created = await createProviderSession(resolved, scopes, requester);
  requireBridge().notifySessionsChanged(info.id);
  return created;
}

/** `authentication.getAccounts`: who the provider currently has, without a token. */
export async function getAccountsForExtension(providerId: string): Promise<AuthAccount[]> {
  const resolved = await resolveProvider(providerId);
  if (resolved === null) return [];
  const seen = new Map<string, AuthAccount>();
  for (const session of await providerSessions(resolved, [])) {
    seen.set(session.account.id, session.account);
  }
  return [...seen.values()];
}

/** `authentication.removeSession`: sign out, and forget that this extension was allowed. */
export async function removeSessionForExtension(
  requester: Requester,
  providerId: string,
  sessionId: string,
): Promise<void> {
  const resolved = await resolveProvider(providerId);
  if (resolved === null) return;
  if (resolved.kind === 'builtin') {
    await resolved.provider.removeSession(sessionId);
  } else {
    const owner = resolved.info.extensionId;
    if (owner === null) return;
    await requireBridge().callProvider(owner, providerId, 'removeSession', [], sessionId);
  }
  await revokeAuthGrant(requester.extensionId, providerId);
  requireBridge().notifySessionsChanged(providerId);
}

/** A provider extension told AXIOM its sessions changed; tell everyone who might care. */
export function notifyProviderSessionsChanged(providerId: string): void {
  requireBridge().notifySessionsChanged(providerId);
}
