export interface FollowTailSnapshot {
  following: boolean;
  programmatic: boolean;
  showJump: boolean;
}

/**
 * Tracks transcript follow intent independently from scroll position. Smooth
 * programmatic scrolls may emit intermediate events far from the tail; those
 * events must not be mistaken for an explicit user scroll-away.
 */
export class FollowTailController {
  #following = true;
  #programmatic = false;
  #showJump = false;

  snapshot(): FollowTailSnapshot {
    return {
      following: this.#following,
      programmatic: this.#programmatic,
      showJump: this.#showJump,
    };
  }

  beginAppend(nearBottom: boolean): boolean {
    if (!this.#following && !nearBottom) {
      this.#showJump = true;
      return false;
    }
    this.#following = true;
    this.#programmatic = true;
    this.#showJump = false;
    return true;
  }

  observeScroll(nearBottom: boolean): FollowTailSnapshot {
    if (this.#programmatic) {
      if (nearBottom) this.#programmatic = false;
      return this.snapshot();
    }
    this.#following = nearBottom;
    this.#showJump = !nearBottom;
    return this.snapshot();
  }

  finishProgrammaticScroll(nearBottom: boolean): FollowTailSnapshot {
    // Explicit user intent clears #programmatic. A stale animation timer must not
    // be allowed to re-enable follow mode after that transition.
    if (!this.#programmatic) return this.snapshot();
    this.#programmatic = false;
    this.#following = nearBottom;
    this.#showJump = !nearBottom;
    return this.snapshot();
  }

  userScrollAway(): FollowTailSnapshot {
    this.#programmatic = false;
    this.#following = false;
    this.#showJump = true;
    return this.snapshot();
  }

  jumpToLatest(): FollowTailSnapshot {
    this.#following = true;
    this.#programmatic = true;
    this.#showJump = false;
    return this.snapshot();
  }

  reset(): FollowTailSnapshot {
    this.#following = true;
    this.#programmatic = false;
    this.#showJump = false;
    return this.snapshot();
  }
}
