import { rootLogger } from '@axiom/shared';
import { ServiceRegistry, type ValidationReport } from '../../common/serviceRegistry';

/**
 * Main service dependency graph (Phase 8 — DI Container). Declares the app's core
 * services and their dependencies in one place so the wiring can be VALIDATED at
 * startup (missing dependencies / cycles) via the pure `ServiceRegistry`. This is
 * the foundation for DI-managed instantiation; today it validates the declared
 * graph as a startup diagnostic while the services still self-initialize (honest
 * partial — migrating each service's construction onto the container is future work).
 *
 * The registered factories are lightweight descriptors (the validator never calls
 * them — it only reads the declared `deps`), so declaring the graph has no side
 * effects and cannot double-initialize anything.
 */
const log = rootLogger.child('services');

/** Build the registry describing the app's service graph (deps reflect real wiring). */
export function buildServiceRegistry(): ServiceRegistry {
  const reg = new ServiceRegistry();
  const stub = (): Record<string, never> => ({});

  // Leaf infrastructure (no deps).
  reg.register('config', stub);
  reg.register('logger', stub);
  reg.register('startupTiming', stub);

  // Local stores + platform services.
  reg.register('settings', stub, { deps: ['config'] });
  reg.register('secrets', stub, { deps: ['config'] });
  reg.register('featureFlags', stub, { deps: ['settings'] });
  reg.register('audit', stub, { deps: ['settings'] });
  reg.register('crashJournal', stub, { deps: ['settings'] });
  reg.register('core', stub, { deps: ['logger'] });
  reg.register('lsp', stub, { deps: ['logger'] });
  reg.register('dap', stub, { deps: ['logger'] });

  // Identity (Supabase, Google OAuth).
  reg.register('supabase', stub, { deps: ['config'] });
  reg.register('sessionManager', stub, { deps: ['supabase', 'secrets'] });
  reg.register('auth', stub, { deps: ['sessionManager', 'supabase'] });

  // AI + agent stack.
  reg.register('aiGateway', stub, { deps: ['logger', 'featureFlags'] });
  reg.register('ai', stub, { deps: ['settings', 'secrets', 'audit', 'aiGateway'] });
  reg.register('rules', stub, { deps: ['audit'] });
  reg.register('agentRuns', stub, { deps: ['logger'] });
  reg.register('agent', stub, {
    deps: ['ai', 'core', 'agentRuns', 'rules', 'featureFlags'],
  });

  return reg;
}

/**
 * Validate the declared service graph at startup and log the result. Best-effort:
 * a wiring problem is surfaced as a warning, never blocks startup.
 */
export function validateServiceGraph(): ValidationReport {
  let report: ValidationReport;
  try {
    report = buildServiceRegistry().validate();
  } catch (e) {
    report = {
      ok: false,
      missing: [],
      cycle: null,
      order: [],
      summary: `Service-graph validation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (report.ok) log.debug('service graph validated (Phase 8)', { summary: report.summary });
  else log.warn('service graph issue (Phase 8)', { summary: report.summary });
  return report;
}
