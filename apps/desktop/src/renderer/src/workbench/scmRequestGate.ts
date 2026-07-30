export type ScmRequestChannel = 'status' | 'history';

export interface ScmCapabilitySnapshot {
  root: string | null;
  generation: number;
}

export interface ScmRequestToken extends ScmCapabilitySnapshot {
  channel: ScmRequestChannel;
  requestId: number;
}

/** Synchronously invalidates stale async work across root and trust capability transitions. */
export class ScmRequestGate {
  private root: string | null = null;
  private generation = 0;
  private active = true;
  private readonly requestIds: Record<ScmRequestChannel, number> = {
    status: 0,
    history: 0,
  };

  setCapability(root: string | null): ScmCapabilitySnapshot {
    if (this.root !== root) {
      this.root = root;
      this.generation += 1;
    }
    return this.snapshot();
  }

  activate(): void {
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
    this.requestIds.status += 1;
    this.requestIds.history += 1;
  }

  invalidate(): void {
    this.active = false;
    this.root = null;
    this.generation += 1;
    this.requestIds.status += 1;
    this.requestIds.history += 1;
  }

  snapshot(): ScmCapabilitySnapshot {
    return { root: this.root, generation: this.generation };
  }

  isCurrent(snapshot: ScmCapabilitySnapshot): boolean {
    return (
      this.active &&
      snapshot.root !== null &&
      snapshot.root === this.root &&
      snapshot.generation === this.generation
    );
  }

  begin(channel: ScmRequestChannel): ScmRequestToken {
    const requestId = ++this.requestIds[channel];
    return { ...this.snapshot(), channel, requestId };
  }

  accepts(token: ScmRequestToken): boolean {
    return this.isCurrent(token) && this.requestIds[token.channel] === token.requestId;
  }
}
