/**
 * Local-first autonomy (Phase 262 — Local-First Autonomy).
 *
 * PURE module (no I/O, no Electron). It decides whether an agent task can run
 * FULLY on a LOCAL model (Ollama / LM Studio — zero egress, zero cost, offline) by
 * comparing the best available local model's capability against the task's quality
 * bar (the cost-autopilot answer floor). When a local model is capable it runs
 * local; when it's close it attempts local but transparently flags that a stronger
 * (remote) model is available; when it's clearly under-powered it recommends the
 * remote fallback — unless the user has chosen offline-only, in which case it runs
 * local anyway and honestly labels the capability risk.
 *
 * Reuses the autopilot capability floor (common/costAutopilot) + the AutopilotModel
 * shape (which carries `capability` + `local`), so the whole model story is
 * consistent across routing, autopilot, and local-first.
 */

import { answerFloor, type AutopilotModel, type Complexity, type RiskLevel } from './costAutopilot';

export interface LocalFitTask {
  complexity: Complexity;
  risk: RiskLevel;
}

export type LocalFitVerdict = 'fit' | 'marginal' | 'unfit' | 'no-local';

export interface LocalFirstDecision {
  verdict: LocalFitVerdict;
  /** Best local model id (null when none available). */
  localModel: string | null;
  /** Capability of the best local model (0 when none). */
  localCapability: number;
  /** The task's quality bar (autopilot answer floor). */
  floor: number;
  /** Run on a local model now (zero egress)? */
  runLocal: boolean;
  /** Recommend a stronger remote model to the user? */
  suggestEscalation: boolean;
  /** Best remote model id to fall back to / suggest (null when none). */
  fallbackModel: string | null;
  reason: string;
  summary: string;
}

export interface LocalFirstOptions {
  /** User wants zero egress — never fall back to remote (default false). */
  offlineOnly?: boolean;
  /** Capability gap below the floor still worth attempting locally (default 15). */
  marginalGap?: number;
}

const DEFAULT_MARGINAL_GAP = 15;

function bestBy(models: readonly AutopilotModel[], local: boolean): AutopilotModel | null {
  let best: AutopilotModel | null = null;
  for (const m of models) {
    if ((m.local === true) !== local) continue;
    if (best === null || m.capability > best.capability) best = m;
  }
  return best;
}

/**
 * Decide the local-first strategy for a task given the available models. Deterministic.
 */
export function decideLocalFirst(
  task: LocalFitTask,
  models: readonly AutopilotModel[],
  options: LocalFirstOptions = {},
): LocalFirstDecision {
  const floor = answerFloor(task);
  const gap = options.marginalGap ?? DEFAULT_MARGINAL_GAP;
  const offlineOnly = options.offlineOnly === true;

  const bestLocal = bestBy(models, true);
  const bestRemote = bestBy(models, false);
  const fallbackModel = bestRemote?.id ?? null;

  // No local model at all.
  if (bestLocal === null) {
    const runLocal = false;
    const reason = offlineOnly
      ? 'Offline-only requested, but no local model is configured.'
      : fallbackModel !== null
        ? `No local model available \u2014 using remote ${fallbackModel}.`
        : 'No models available.';
    return {
      verdict: 'no-local',
      localModel: null,
      localCapability: 0,
      floor,
      runLocal,
      suggestEscalation: false,
      fallbackModel,
      reason,
      summary: `Local-first: no local model (${reason}).`,
    };
  }

  const cap = bestLocal.capability;
  let verdict: LocalFitVerdict;
  let runLocal: boolean;
  let suggestEscalation: boolean;
  let reason: string;

  if (cap >= floor) {
    verdict = 'fit';
    runLocal = true;
    suggestEscalation = false;
    reason = `Local model ${bestLocal.id} (capability ${cap}) meets the bar (${floor}) \u2014 running fully local (zero egress).`;
  } else if (cap >= floor - gap) {
    verdict = 'marginal';
    runLocal = true;
    suggestEscalation = fallbackModel !== null;
    reason =
      `Local model ${bestLocal.id} (capability ${cap}) is close to the bar (${floor}) \u2014 ` +
      (fallbackModel !== null
        ? `attempting locally; a stronger model (${fallbackModel}) is available if results fall short.`
        : 'attempting locally.');
  } else {
    verdict = 'unfit';
    if (offlineOnly) {
      runLocal = true;
      suggestEscalation = false;
      reason = `Offline-only: running on ${bestLocal.id} (capability ${cap}) despite being below the bar (${floor}); results may be limited.`;
    } else if (fallbackModel !== null) {
      runLocal = false;
      suggestEscalation = true;
      reason = `No local model meets the bar (${floor}); best local ${bestLocal.id} (capability ${cap}). Recommending remote ${fallbackModel}.`;
    } else {
      runLocal = true;
      suggestEscalation = false;
      reason = `Best (and only) local model ${bestLocal.id} (capability ${cap}) is below the bar (${floor}); no remote available, running local.`;
    }
  }

  return {
    verdict,
    localModel: bestLocal.id,
    localCapability: cap,
    floor,
    runLocal,
    suggestEscalation,
    fallbackModel,
    reason,
    summary: `Local-first: ${verdict} \u2014 ${runLocal ? `run ${bestLocal.id} locally` : `use remote ${fallbackModel ?? '(none)'}`}.`,
  };
}

/** True when the task can run fully offline on a local model (fit or marginal). */
export function canRunOffline(decision: LocalFirstDecision): boolean {
  return decision.runLocal && (decision.verdict === 'fit' || decision.verdict === 'marginal');
}
