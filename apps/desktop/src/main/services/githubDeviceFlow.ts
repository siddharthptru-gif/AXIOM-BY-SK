import type { GithubAccount, GithubDeviceFlow, GithubFlowPollResult } from '../../common/ipc';

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type DeviceTokenResponse =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | {
      kind: 'terminal';
      code: 'expired' | 'access_denied' | 'device_flow_disabled' | 'provider_error';
      message: string;
    }
  | { kind: 'success'; access: string; scopes: string[] };

export interface ValidatedDeviceAccount {
  account: GithubAccount;
  scopes: string[];
}

export interface GithubDeviceFlowDependencies {
  now: () => number;
  createId: () => string;
  startTimeoutMs: number;
  maximumFlows: number;
  verificationUrl: GithubDeviceFlow['verificationUrl'];
  requestDeviceAuthorization: (
    signal: AbortSignal,
    deadline: number,
    checkpoint: () => void,
  ) => Promise<DeviceAuthorizationResponse>;
  requestToken: (
    deviceCode: string,
    signal: AbortSignal,
    deadline: number,
    checkpoint: () => void,
  ) => Promise<DeviceTokenResponse>;
  validateAccount: (
    access: string,
    scopes: string[],
    signal: AbortSignal,
    deadline: number,
    checkpoint: () => void,
  ) => Promise<ValidatedDeviceAccount>;
  persistCredential: (access: string, scopes: string[]) => Promise<void>;
  clearCredential: (expectedAccess?: string) => Promise<void>;
  wait: (milliseconds: number, signal: AbortSignal, deadline: number) => Promise<void>;
  nextPollIntervalSeconds: (current: number, slowDown: boolean) => number;
}

interface PendingFlow {
  id: string;
  ownerId: number;
  generation: number;
  credentialEpoch: number;
  deviceCode: string | null;
  userCode: string | null;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  controller: AbortController;
  cancelled: boolean;
  polling: boolean;
}

type InactiveKind = 'cancelled' | 'expired';

class InactiveFlowError extends Error {
  constructor(readonly kind: InactiveKind) {
    super(kind === 'expired' ? 'Device authorization expired.' : 'Device authorization cancelled.');
    this.name = 'InactiveFlowError';
  }
}

const CANCELLED_RESULT: GithubFlowPollResult = {
  status: 'cancelled',
  message: 'GitHub connection was cancelled.',
};
const EXPIRED_RESULT: GithubFlowPollResult = {
  status: 'expired',
  message: 'The GitHub device code expired. Start again.',
};

/**
 * Owner-bound Device Flow coordinator. All credential mutations use one queue,
 * while owner generations synchronously invalidate late asynchronous results.
 */
export class GithubDeviceFlowMachine {
  private readonly flows = new Map<string, PendingFlow>();
  private readonly ownerFlows = new Map<number, PendingFlow>();
  private readonly ownerGenerations = new Map<number, number>();
  private credentialEpoch = 0;
  private credentialTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: GithubDeviceFlowDependencies) {}

  private inactiveKind(flow: PendingFlow): InactiveKind | null {
    if (this.dependencies.now() >= flow.expiresAt) return 'expired';
    if (
      flow.cancelled ||
      flow.controller.signal.aborted ||
      flow.credentialEpoch !== this.credentialEpoch ||
      this.flows.get(flow.id) !== flow ||
      this.ownerFlows.get(flow.ownerId) !== flow ||
      this.ownerGenerations.get(flow.ownerId) !== flow.generation
    ) {
      return 'cancelled';
    }
    return null;
  }

  private checkpoint(flow: PendingFlow): void {
    const inactive = this.inactiveKind(flow);
    if (inactive) throw new InactiveFlowError(inactive);
  }

  private terminalResult(kind: InactiveKind): GithubFlowPollResult {
    return kind === 'expired' ? EXPIRED_RESULT : CANCELLED_RESULT;
  }

  private remove(flow: PendingFlow): void {
    if (this.flows.get(flow.id) === flow) this.flows.delete(flow.id);
    if (this.ownerFlows.get(flow.ownerId) === flow) this.ownerFlows.delete(flow.ownerId);
  }

  private cancelFlow(flow: PendingFlow): void {
    flow.cancelled = true;
    flow.controller.abort();
    this.remove(flow);
  }

  private pruneExpired(): void {
    for (const flow of this.flows.values()) {
      if (this.dependencies.now() >= flow.expiresAt && !flow.polling) this.cancelFlow(flow);
    }
  }

  private serializeCredential<T>(action: () => Promise<T>): Promise<T> {
    const result = this.credentialTail.then(action, action);
    this.credentialTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private flowView(flow: PendingFlow): GithubDeviceFlow {
    this.checkpoint(flow);
    if (flow.userCode === null) throw new InactiveFlowError('cancelled');
    return {
      flowId: flow.id,
      userCode: flow.userCode,
      verificationUrl: this.dependencies.verificationUrl,
      expiresAt: flow.expiresAt,
      intervalSeconds: flow.intervalSeconds,
    };
  }

  private requireOwnedFlow(ownerId: number, flowId: unknown): PendingFlow {
    if (typeof flowId !== 'string' || !/^[A-Za-z0-9_-]{24,64}$/.test(flowId)) {
      throw new Error('Device authorization flow id is invalid.');
    }
    const flow = this.flows.get(flowId);
    if (!flow || flow.ownerId !== ownerId || this.ownerFlows.get(ownerId) !== flow) {
      throw new Error('Device authorization flow is no longer available.');
    }
    return flow;
  }

  /** Reserves this owner synchronously, before the first outbound request await. */
  start(ownerId: number): Promise<GithubDeviceFlow> {
    this.pruneExpired();
    const prior = this.ownerFlows.get(ownerId);
    if (prior) this.cancelFlow(prior);
    if (this.flows.size >= this.dependencies.maximumFlows) {
      return Promise.reject(
        new Error('Too many GitHub authorization attempts are active. Try again shortly.'),
      );
    }

    const generation = (this.ownerGenerations.get(ownerId) ?? 0) + 1;
    this.ownerGenerations.set(ownerId, generation);
    const now = this.dependencies.now();
    const flow: PendingFlow = {
      id: this.dependencies.createId(),
      ownerId,
      generation,
      credentialEpoch: this.credentialEpoch,
      deviceCode: null,
      userCode: null,
      expiresAt: now + this.dependencies.startTimeoutMs,
      intervalSeconds: 5,
      nextPollAt: now,
      controller: new AbortController(),
      cancelled: false,
      polling: false,
    };
    this.flows.set(flow.id, flow);
    this.ownerFlows.set(ownerId, flow);

    return this.finishStart(flow);
  }

  private async finishStart(flow: PendingFlow): Promise<GithubDeviceFlow> {
    try {
      const response = await this.dependencies.requestDeviceAuthorization(
        flow.controller.signal,
        flow.expiresAt,
        () => this.checkpoint(flow),
      );
      this.checkpoint(flow);
      const now = this.dependencies.now();
      flow.deviceCode = response.deviceCode;
      flow.userCode = response.userCode;
      flow.expiresAt = now + response.expiresInSeconds * 1_000;
      flow.intervalSeconds = response.intervalSeconds;
      flow.nextPollAt = now + response.intervalSeconds * 1_000;
      this.checkpoint(flow);
      return this.flowView(flow);
    } catch (error) {
      const inactive = error instanceof InactiveFlowError ? error.kind : this.inactiveKind(flow);
      this.cancelFlow(flow);
      if (inactive === 'expired') throw new Error('The GitHub device code expired. Start again.');
      if (inactive === 'cancelled') throw new Error('GitHub connection was cancelled.');
      throw new Error('GitHub could not start device authorization.');
    }
  }

  async poll(ownerId: number, flowId: unknown): Promise<GithubFlowPollResult> {
    const flow = this.requireOwnedFlow(ownerId, flowId);
    const initiallyInactive = this.inactiveKind(flow);
    if (initiallyInactive) {
      this.cancelFlow(flow);
      return this.terminalResult(initiallyInactive);
    }
    if (flow.polling) throw new Error('A GitHub authorization poll is already active.');
    if (flow.deviceCode === null) return CANCELLED_RESULT;

    flow.polling = true;
    let accessForCleanup: string | null = null;
    try {
      const waitUntil = Math.min(flow.nextPollAt, flow.expiresAt);
      const waitMs = Math.max(0, waitUntil - this.dependencies.now());
      if (waitMs > 0) {
        await this.dependencies.wait(waitMs, flow.controller.signal, flow.expiresAt);
        this.checkpoint(flow);
      }

      this.checkpoint(flow);
      flow.nextPollAt = this.dependencies.now() + flow.intervalSeconds * 1_000;
      const token = await this.dependencies.requestToken(
        flow.deviceCode,
        flow.controller.signal,
        flow.expiresAt,
        () => this.checkpoint(flow),
      );
      this.checkpoint(flow);

      if (token.kind === 'pending') {
        return {
          status: 'pending',
          flow: this.flowView(flow),
          message: 'Waiting for GitHub authorization…',
        };
      }
      if (token.kind === 'slow_down') {
        flow.intervalSeconds = this.dependencies.nextPollIntervalSeconds(
          flow.intervalSeconds,
          true,
        );
        flow.nextPollAt = this.dependencies.now() + flow.intervalSeconds * 1_000;
        this.checkpoint(flow);
        return {
          status: 'slow_down',
          flow: this.flowView(flow),
          message: 'GitHub asked Axiom to check less frequently.',
        };
      }
      if (token.kind === 'terminal') {
        this.cancelFlow(flow);
        return {
          status: token.code === 'provider_error' ? 'error' : token.code,
          message: token.message,
        };
      }

      accessForCleanup = token.access;
      const validated = await this.dependencies.validateAccount(
        token.access,
        token.scopes,
        flow.controller.signal,
        flow.expiresAt,
        () => this.checkpoint(flow),
      );
      this.checkpoint(flow);

      const persistenceInactive = await this.serializeCredential(async () => {
        const before = this.inactiveKind(flow);
        if (before) return before;
        this.checkpoint(flow);
        await this.dependencies.persistCredential(token.access, validated.scopes);
        const after = this.inactiveKind(flow);
        if (after) {
          await this.dependencies.clearCredential(token.access);
          return after;
        }
        this.checkpoint(flow);
        return null;
      });

      const afterPersistence = persistenceInactive ?? this.inactiveKind(flow);
      if (afterPersistence) {
        await this.serializeCredential(() => this.dependencies.clearCredential(token.access));
        this.cancelFlow(flow);
        return this.terminalResult(afterPersistence);
      }
      this.checkpoint(flow);
      this.remove(flow);
      return {
        status: 'connected',
        account: validated.account,
        message: `Connected to GitHub as ${validated.account.login}.`,
      };
    } catch (error) {
      const inactive = error instanceof InactiveFlowError ? error.kind : this.inactiveKind(flow);
      if (accessForCleanup !== null && inactive) {
        await this.serializeCredential(() =>
          this.dependencies.clearCredential(accessForCleanup ?? undefined),
        );
      }
      this.cancelFlow(flow);
      if (inactive) return this.terminalResult(inactive);
      return { status: 'error', message: 'GitHub authorization failed. Try again.' };
    } finally {
      flow.polling = false;
    }
  }

  cancel(ownerId: number, flowId: unknown): void {
    const flow = this.requireOwnedFlow(ownerId, flowId);
    this.cancelFlow(flow);
  }

  assertOwned(ownerId: number, flowId: unknown): void {
    const flow = this.requireOwnedFlow(ownerId, flowId);
    this.checkpoint(flow);
  }

  cancelOwner(ownerId: number): void {
    const flow = this.ownerFlows.get(ownerId);
    if (flow) this.cancelFlow(flow);
    this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1);
  }

  cancelAll(): void {
    for (const flow of [...this.flows.values()]) this.cancelFlow(flow);
    for (const ownerId of this.ownerGenerations.keys()) {
      this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1);
    }
  }

  /** Epoch invalidation happens synchronously, before encrypted deletion awaits. */
  disconnect(ownerId: number): Promise<void> {
    this.credentialEpoch += 1;
    this.cancelAll();
    this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1);
    return this.serializeCredential(async () => {
      await this.dependencies.clearCredential();
    });
  }
}
