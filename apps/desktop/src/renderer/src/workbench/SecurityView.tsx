import { useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { notifyInfo, notifyError } from '../notifications/bus';
import { ChevronIcon } from './treeIcons';
import {
  BalanceIcon,
  BeakerIcon,
  FileIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  PackageIcon,
  PulseIcon,
  RocketIcon,
  ShieldIcon,
} from './icons';
import { scanForSecrets, summarizeFindings, type SecretFinding } from '../../../common/secretScan';
import {
  runFitnessChecks,
  summarizeFitness,
  type FitnessFinding,
} from '../../../common/securityFitness';
import { scanDependencies, summarizeDeps, type DepFinding } from '../../../common/depScan';
import {
  evaluateLicenses,
  categoriesPresent,
  type LicenseReport,
  type DependencyLicense,
} from '../../../common/licenseAudit';
import { buildSbom, serializeSbom, summarizeSbom, parseLockResolved } from '../../../common/sbom';
import { scanSast, summarizeSast, type SastFinding } from '../../../common/sastRules';
import {
  aggregateHealth,
  type HealthReport,
  type HealthSignal,
  type HealthSeverity,
} from '../../../common/codebaseHealth';
import {
  reviewEgress,
  discoverEgressEndpoints,
  type EgressReview,
} from '../../../common/egressReview';
import { auditRls, parseRlsSchema, type RlsAuditResult } from '../../../common/rlsAudit';
import { evaluateGaGate, type GaCheck, type GaGateResult } from '../../../common/gaGate';
import type { HealthKind } from '../../../common/codebaseHealth';

/** Bounded provenance for a workspace-derived audit (what was actually read). */
interface EvidenceProvenance {
  root: string;
  filesScanned: number;
  truncated: boolean;
  at: number;
}

/**
 * Security panel (PRD Epoch J §184/§190 / Phase 271). Scans the active file for
 * secret-shaped strings and risky code patterns using the pure `common/secretScan`
 * module, listing REDACTED findings (never the full secret) with click-to-line.
 * A lightweight local scanner — full SAST/SCA/fuzzing CI gates are out of scope.
 */
function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function SecurityView() {
  const ws = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [findings, setFindings] = useState<SecretFinding[] | null>(null);
  const [scanned, setScanned] = useState<string | null>(null);
  const [fitness, setFitness] = useState<FitnessFinding[] | null>(null);
  const [deps, setDeps] = useState<DepFinding[] | null>(null);
  const [sast, setSast] = useState<SastFinding[] | null>(null);
  const [licenses, setLicenses] = useState<LicenseReport | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [egress, setEgress] = useState<EgressReview | null>(null);
  const [egressProvenance, setEgressProvenance] = useState<EvidenceProvenance | null>(null);
  const [rls, setRls] = useState<RlsAuditResult | null>(null);
  const [rlsProvenance, setRlsProvenance] = useState<EvidenceProvenance | null>(null);
  const [gaGate, setGaGate] = useState<GaGateResult | null>(null);

  const scanDeps = async (): Promise<void> => {
    const root = ws.rootPath;
    if (!root) {
      notifyInfo('Open a folder to scan dependencies.', { source: 'Security' });
      return;
    }
    try {
      const file = await window.axiom.fs.readFile(`${root}/package.json`);
      const pkg = JSON.parse(file.content) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const found = scanDependencies({
        ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
        ...(pkg.devDependencies ? { devDependencies: pkg.devDependencies } : {}),
      });
      setDeps(found);
      const s = summarizeDeps(found);
      notifyInfo(
        found.length === 0
          ? 'No risky dependencies found.'
          : `${s.total} dependency finding(s): ${s.critical} critical, ${s.high} high, ${s.medium} medium.`,
        { source: 'Security' },
      );
    } catch (e) {
      notifyError('Could not scan dependencies', { source: 'Security', detail: detailOf(e) });
    }
  };

  const auditLicenses = async (): Promise<void> => {
    const root = ws.rootPath;
    if (!root) {
      notifyInfo('Open a folder to audit dependency licenses.', { source: 'Security' });
      return;
    }
    try {
      const file = await window.axiom.fs.readFile(`${root}/package.json`);
      const pkg = JSON.parse(file.content) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const names = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ].slice(0, 80);
      const collected: DependencyLicense[] = [];
      for (const name of names) {
        let license = '';
        let version: string | undefined;
        try {
          const dpFile = await window.axiom.fs.readFile(
            `${root}/node_modules/${name}/package.json`,
          );
          const dp = JSON.parse(dpFile.content) as {
            version?: unknown;
            license?: unknown;
            licenses?: unknown;
          };
          if (typeof dp.version === 'string') version = dp.version;
          if (typeof dp.license === 'string') license = dp.license;
          else if (Array.isArray(dp.licenses)) {
            const first = dp.licenses.find(
              (l): l is { type?: string } => !!l && typeof l === 'object',
            );
            license = typeof first?.type === 'string' ? first.type : '';
          }
        } catch {
          /* not installed / unreadable → unknown license */
        }
        collected.push({ name, ...(version !== undefined ? { version } : {}), license });
      }
      const report = evaluateLicenses(collected);
      setLicenses(report);
      notifyInfo(report.summary, { source: 'Security' });
    } catch (e) {
      notifyError('Could not audit licenses', { source: 'Security', detail: detailOf(e) });
    }
  };

  const runHealth = (): void => {
    const sev = (s: string): HealthSeverity =>
      s === 'critical' || s === 'high' || s === 'medium' || s === 'low' ? s : 'medium';
    const signals: HealthSignal[] = [];
    // Only scans that were actually run contribute coverage — a clean result is
    // only "healthy" for the kinds that were scanned (honest, no fake 100/100).
    const assessedKinds = new Set<HealthKind>();
    if (deps !== null) assessedKinds.add('dep-risk');
    if (sast !== null || findings !== null) assessedKinds.add('security');
    if (fitness !== null) assessedKinds.add('lint');
    for (const d of deps ?? [])
      signals.push({
        kind: 'dep-risk',
        severity: sev(d.severity),
        title: `${d.name}: ${d.reason}`,
        fixable: true,
      });
    for (const s of sast ?? [])
      signals.push({ kind: 'security', severity: sev(s.severity), title: s.label });
    for (const f of findings ?? [])
      signals.push({ kind: 'security', severity: sev(f.severity), title: f.label });
    for (const f of fitness ?? [])
      signals.push({ kind: 'lint', severity: sev(f.severity), title: f.label });
    if (assessedKinds.size === 0) {
      notifyInfo('Run a secret, SAST, dependency, or fitness scan before scoring health.', {
        source: 'Security',
      });
    }
    const report = aggregateHealth(signals, [...assessedKinds]);
    setHealth(report);
    notifyInfo(report.summary, { source: 'Security' });
  };

  const reviewEgressSurface = async (): Promise<void> => {
    const root = ws.rootPath;
    if (!root) {
      notifyInfo('Open a folder to review its egress surface.', { source: 'Security' });
      return;
    }
    try {
      // Discover outbound destinations actually referenced in the selected workspace.
      const result = await window.axiom.fs.search(root, 'https?://|wss?://|ftp://', {
        caseSensitive: false,
        wholeWord: false,
        regex: true,
      });
      const text = result.files
        .flatMap((file) => file.matches.map((match) => match.preview))
        .join('\n')
        .slice(0, 500_000);
      const endpoints = discoverEgressEndpoints(text);
      const report = reviewEgress(endpoints);
      setEgress(report);
      setEgressProvenance({
        root,
        filesScanned: result.files.length,
        truncated: result.truncated,
        at: Date.now(),
      });
      notifyInfo(
        endpoints.length === 0
          ? 'No outbound URLs were found in this workspace.'
          : report.summary,
        { source: 'Security' },
      );
    } catch (e) {
      notifyError('Could not review the egress surface', {
        source: 'Security',
        detail: detailOf(e),
      });
    }
  };

  const runRlsAudit = async (): Promise<void> => {
    const root = ws.rootPath;
    if (!root) {
      notifyInfo('Open a folder to audit RLS policies.', { source: 'Security' });
      return;
    }
    try {
      // Find SQL that declares policies or enables RLS, then lint the parsed schema.
      const result = await window.axiom.fs.search(
        root,
        'create\\s+policy|row\\s+level\\s+security',
        { caseSensitive: false, wholeWord: false, regex: true },
      );
      const sqlFiles = result.files
        .filter((file) => /\.(sql|pgsql)$/i.test(file.rel))
        .slice(0, 20);
      let combined = '';
      for (const file of sqlFiles) {
        if (combined.length >= 400_000) break;
        try {
          const content = await window.axiom.fs.readFile(file.path);
          combined += `\n${content.content}`;
        } catch {
          /* unreadable file — skip, provenance reflects the reduced count */
        }
      }
      const tables = parseRlsSchema(combined);
      const report = auditRls(tables);
      setRls(report);
      setRlsProvenance({
        root,
        filesScanned: sqlFiles.length,
        truncated: result.truncated || sqlFiles.length < result.files.length,
        at: Date.now(),
      });
      notifyInfo(
        tables.length === 0
          ? 'No SQL schema with RLS policies was found in this workspace.'
          : report.summary,
        { source: 'Security' },
      );
    } catch (e) {
      notifyError('Could not audit RLS policies', { source: 'Security', detail: detailOf(e) });
    }
  };

  const runGaGate = (): void => {
    // Release-readiness gate (PRD Phase 274): fold the audits actually run in this
    // session into a go / conditional / no-go verdict. Audits not yet run count as
    // 'skip' (honest — the verdict reflects only what was checked). A failing
    // security/stability blocker forces no-go; non-blocking fails/warns → conditional.
    const worst = (sevs: readonly { severity: string }[]): 'pass' | 'warn' | 'fail' =>
      sevs.some((x) => x.severity === 'critical' || x.severity === 'high')
        ? 'fail'
        : sevs.length > 0
          ? 'warn'
          : 'pass';
    const checks: GaCheck[] = [
      {
        category: 'security',
        label: 'Secret scan (active file)',
        status: findings === null ? 'skip' : worst(findings),
      },
      { category: 'security', label: 'SAST rules', status: sast === null ? 'skip' : worst(sast) },
      {
        category: 'security',
        label: 'Security fitness',
        status: fitness === null ? 'skip' : worst(fitness),
      },
      {
        category: 'security',
        label: 'Dependency risk',
        status: deps === null ? 'skip' : worst(deps),
      },
      {
        category: 'security',
        label: 'Egress surface',
        status: egress === null ? 'skip' : worst(egress.findings),
      },
      {
        category: 'security',
        label: 'RLS policies',
        status: rls === null ? 'skip' : worst(rls.findings),
      },
      {
        category: 'docs',
        label: 'Dependency licenses',
        status:
          licenses === null
            ? 'skip'
            : licenses.denied.length > 0
              ? 'fail'
              : licenses.flagged.length > 0
                ? 'warn'
                : 'pass',
      },
      {
        category: 'stability',
        label: 'Codebase health',
        status:
          health === null || health.score === null
            ? 'skip'
            : health.score >= 80
              ? 'pass'
              : health.score >= 60
                ? 'warn'
                : 'fail',
      },
    ];
    const result = evaluateGaGate(checks);
    setGaGate(result);
    notifyInfo(result.summary, { source: 'Security' });
  };

  const exportSbom = async (): Promise<void> => {
    const root = ws.rootPath;
    if (!root) {
      notifyInfo('Open a folder to export an SBOM.', { source: 'Security' });
      return;
    }
    try {
      const pkgFile = await window.axiom.fs.readFile(`${root}/package.json`);
      const pkg = JSON.parse(pkgFile.content) as {
        name?: unknown;
        version?: unknown;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      // A lockfile (when present) gives exact resolved versions + the transitive set.
      let resolved: Record<string, string> = {};
      try {
        const lockFile = await window.axiom.fs.readFile(`${root}/package-lock.json`);
        resolved = parseLockResolved(JSON.parse(lockFile.content));
      } catch {
        /* no lockfile — export direct dependencies with their range-derived versions */
      }
      const sbom = buildSbom({
        ...(typeof pkg.name === 'string' ? { name: pkg.name } : {}),
        ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
        ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
        ...(pkg.devDependencies ? { devDependencies: pkg.devDependencies } : {}),
        resolved,
      });
      const target = await window.axiom.dialog.saveFile('axiom-sbom.json');
      if (!target) return;
      await window.axiom.fs.writeFile(target.path, serializeSbom(sbom));
      const s = summarizeSbom(sbom);
      notifyInfo(
        `Exported SBOM to ${target.name} — ${s.total} components (${s.required} required, ${s.optional} optional).`,
        { source: 'Security' },
      );
    } catch (e) {
      notifyError('Could not export SBOM', { source: 'Security', detail: detailOf(e) });
    }
  };

  const scan = async (): Promise<void> => {
    const path = ws.activePath;
    if (!path) {
      notifyInfo('Open a file to scan it for secrets.', { source: 'Security' });
      return;
    }
    try {
      const file = await window.axiom.fs.readFile(path);
      const found = scanForSecrets(file.content);
      setFindings(found);
      setScanned(baseName(path));
      const s = summarizeFindings(found);
      notifyInfo(
        found.length === 0
          ? `No secrets found in ${baseName(path)}.`
          : `${s.total} finding(s) in ${baseName(path)}: ${s.critical} critical, ${s.high} high, ${s.medium} medium.`,
        { source: 'Security' },
      );
    } catch (e) {
      notifyError('Could not scan file', { source: 'Security', detail: detailOf(e) });
    }
  };

  const openAt = (f: SecretFinding): void => {
    const path = ws.activePath;
    if (path) ws.openFileAt(path, baseName(path), f.line, f.column);
  };

  const runFitness = async (): Promise<void> => {
    const path = ws.activePath;
    if (!path) {
      notifyInfo('Open a file to run fitness checks.', { source: 'Security' });
      return;
    }
    try {
      const file = await window.axiom.fs.readFile(path);
      const found = runFitnessChecks(file.content);
      setFitness(found);
      const s = summarizeFitness(found);
      notifyInfo(
        s.pass
          ? `Fitness checks passed for ${baseName(path)} (${s.checks} checks).`
          : `${s.violations} fitness violation(s) in ${baseName(path)}.`,
        { source: 'Security' },
      );
    } catch (e) {
      notifyError('Could not run fitness checks', { source: 'Security', detail: detailOf(e) });
    }
  };

  const openFitnessAt = (f: FitnessFinding): void => {
    const path = ws.activePath;
    if (path) ws.openFileAt(path, baseName(path), f.line, 1);
  };

  const runSast = async (): Promise<void> => {
    const path = ws.activePath;
    if (!path) {
      notifyInfo('Open a file to run the SAST rules.', { source: 'Security' });
      return;
    }
    try {
      const file = await window.axiom.fs.readFile(path);
      const found = scanSast(file.content);
      setSast(found);
      const s = summarizeSast(found);
      notifyInfo(
        s.pass
          ? `SAST: no issues in ${baseName(path)}.`
          : `SAST: ${s.total} issue(s) in ${baseName(path)} — ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low.`,
        { source: 'Security' },
      );
    } catch (e) {
      notifyError('Could not run the SAST rules', { source: 'Security', detail: detailOf(e) });
    }
  };

  const openSastAt = (f: SastFinding): void => {
    const path = ws.activePath;
    if (path) ws.openFileAt(path, baseName(path), f.line, f.column);
  };

  return (
    <div className="security-view">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">Security</span>
        {!collapsed && findings ? <span className="oe-count">{findings.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="security-body">
          <button type="button" className="btn btn-ghost sec-scan" onClick={() => void scan()}>
            <KeyIcon size={14} /> Scan active file for secrets
          </button>
          {findings === null ? null : findings.length === 0 ? (
            <div className="outline-empty">No secrets found in {scanned}.</div>
          ) : (
            findings.map((f, i) => (
              <button
                key={`${f.line}-${f.patternId}-${i}`}
                type="button"
                className="sec-row"
                title={`${f.label} — ${f.preview}`}
                onClick={() => openAt(f)}
              >
                <span className={`sec-sev sec-sev-${f.severity}`}>{f.severity}</span>
                <span className="sec-label">{f.label}</span>
                <span className="sec-loc">:{f.line}</span>
              </button>
            ))
          )}
          <button
            type="button"
            className="btn btn-ghost sec-scan"
            onClick={() => void runFitness()}
          >
            <ShieldIcon size={14} /> Run security fitness checks
          </button>
          {fitness === null ? null : fitness.length === 0 ? (
            <div className="outline-empty">Fitness checks passed {'\u2014'} no violations.</div>
          ) : (
            fitness.map((f, i) => (
              <button
                key={`fit-${f.line}-${f.id}-${i}`}
                type="button"
                className="sec-row"
                title={`${f.label} — ${f.snippet}`}
                onClick={() => openFitnessAt(f)}
              >
                <span className={`sec-sev sec-sev-${f.severity}`}>{f.severity}</span>
                <span className="sec-label">{f.label}</span>
                <span className="sec-loc">:{f.line}</span>
              </button>
            ))
          )}
          <button type="button" className="btn btn-ghost sec-scan" onClick={() => void runSast()}>
            <BeakerIcon size={14} /> Run SAST rules
          </button>
          {sast === null ? null : sast.length === 0 ? (
            <div className="outline-empty">No SAST issues found.</div>
          ) : (
            <>
              <div className="outline-empty">
                {(() => {
                  const s = summarizeSast(sast);
                  return `${s.total} issue(s): ${s.critical} critical \u00B7 ${s.high} high \u00B7 ${s.medium} medium \u00B7 ${s.low} low`;
                })()}
              </div>
              {sast.map((f, i) => (
                <button
                  key={`sast-${f.line}-${f.id}-${i}`}
                  type="button"
                  className="sec-row"
                  title={`${f.label} — ${f.recommendation}`}
                  onClick={() => openSastAt(f)}
                >
                  <span
                    className={`sec-sev sec-sev-${f.severity === 'low' ? 'medium' : f.severity}`}
                  >
                    {f.severity}
                  </span>
                  <span className="sec-label">{f.label}</span>
                  <span className="sec-loc">:{f.line}</span>
                </button>
              ))}
            </>
          )}
          <button type="button" className="btn btn-ghost sec-scan" onClick={() => void scanDeps()}>
            <PackageIcon size={14} /> Scan dependencies
          </button>
          <button
            type="button"
            className="btn btn-ghost sec-scan"
            onClick={() => void exportSbom()}
          >
            <FileIcon size={14} /> Export SBOM (CycloneDX)
          </button>
          {deps === null ? null : deps.length === 0 ? (
            <div className="outline-empty">No risky dependencies found.</div>
          ) : (
            deps.map((d, i) => (
              <div
                key={`dep-${d.name}-${i}`}
                className="sec-row"
                title={`${d.name}@${d.version} — ${d.reason}`}
              >
                <span className={`sec-sev sec-sev-${d.severity === 'low' ? 'medium' : d.severity}`}>
                  {d.severity}
                </span>
                <span className="sec-label">
                  {d.name} — {d.reason}
                </span>
              </div>
            ))
          )}
          <button
            type="button"
            className="btn btn-ghost sec-scan"
            onClick={() => void auditLicenses()}
          >
            <BalanceIcon size={14} /> Audit dependency licenses
          </button>
          {licenses === null ? null : (
            <>
              <div className="outline-empty">
                {licenses.summary}
                {categoriesPresent(licenses).length > 0
                  ? ` (${categoriesPresent(licenses).join(', ')})`
                  : ''}
              </div>
              {[...licenses.denied, ...licenses.flagged].map((l, i) => (
                <div
                  key={`lic-${l.name}-${i}`}
                  className="sec-row"
                  title={`${l.name}@${l.version ?? '?'} — ${l.license || 'no license'} (${l.category})`}
                >
                  <span
                    className={`sec-sev sec-sev-${l.action === 'deny' ? 'critical' : 'medium'}`}
                  >
                    {l.action}
                  </span>
                  <span className="sec-label">
                    {l.name} — {l.license || 'no license'} ({l.category})
                  </span>
                </div>
              ))}
            </>
          )}
          <button type="button" className="btn btn-ghost sec-scan" onClick={runHealth}>
            <PulseIcon size={14} /> Codebase health score
          </button>
          {health === null ? null : (
            <div className="outline-empty" title="Ambient codebase health (PRD Phase 259)">
              {health.summary}
            </div>
          )}
          <button
            type="button"
            className="btn btn-ghost sec-scan"
            onClick={() => void reviewEgressSurface()}
          >
            <GlobeIcon size={14} /> Review egress surface
          </button>
          {egress === null ? null : (
            <>
              <div className="outline-empty" title="Egress hardening review (PRD Phase 272)">
                Egress: {egress.summary}
                {egressProvenance
                  ? ` \u00B7 ${egressProvenance.filesScanned} file(s)${egressProvenance.truncated ? ' (truncated)' : ''}`
                  : ''}
              </div>
              {egress.findings.map((f, i) => (
                <div key={`eg-${i}`} className="sec-row" title={f.issue}>
                  <span
                    className={`sec-sev sec-sev-${f.severity === 'low' ? 'medium' : f.severity}`}
                  >
                    {f.severity}
                  </span>
                  <span className="sec-label">
                    {f.host} — {f.issue}
                  </span>
                </div>
              ))}
            </>
          )}
          <button
            type="button"
            className="btn btn-ghost sec-scan"
            onClick={() => void runRlsAudit()}
          >
            <LockIcon size={14} /> Audit RLS policies
          </button>
          {rls === null ? null : (
            <>
              <div className="outline-empty" title="RLS & Edge audit (PRD Phase 273)">
                RLS: {rls.summary}
                {rlsProvenance
                  ? ` \u00B7 ${rlsProvenance.filesScanned} SQL file(s)${rlsProvenance.truncated ? ' (truncated)' : ''}`
                  : ''}
              </div>
              {rls.findings.map((f, i) => (
                <div key={`rls-${i}`} className="sec-row" title={f.issue}>
                  <span
                    className={`sec-sev sec-sev-${f.severity === 'low' ? 'medium' : f.severity}`}
                  >
                    {f.severity}
                  </span>
                  <span className="sec-label">
                    {f.table}
                    {f.policy ? `.${f.policy}` : ''} — {f.issue}
                  </span>
                </div>
              ))}
            </>
          )}
          <button type="button" className="btn btn-ghost sec-scan" onClick={runGaGate}>
            <RocketIcon size={14} /> GA readiness gate
          </button>
          {gaGate === null ? null : (
            <>
              <div
                className={`outline-empty sec-ga sec-ga-${gaGate.verdict}`}
                title="Release readiness (PRD Phase 274) — aggregates the audits run above"
              >
                {gaGate.summary}
              </div>
              {gaGate.blockers.map((c, i) => (
                <div
                  key={`ga-b-${i}`}
                  className="sec-row"
                  title={`${c.category} \u2014 ${c.label}`}
                >
                  <span className="sec-sev sec-sev-critical">{c.status}</span>
                  <span className="sec-label">
                    {c.label} ({c.category})
                  </span>
                </div>
              ))}
              {gaGate.warnings.map((c, i) => (
                <div
                  key={`ga-w-${i}`}
                  className="sec-row"
                  title={`${c.category} \u2014 ${c.label}`}
                >
                  <span className="sec-sev sec-sev-medium">{c.status}</span>
                  <span className="sec-label">
                    {c.label} ({c.category})
                  </span>
                </div>
              ))}
              {gaGate.skippedBlockers.map((c, i) => (
                <div
                  key={`ga-s-${i}`}
                  className="sec-row"
                  title={`${c.category} \u2014 ${c.label} not evaluated`}
                >
                  <span className="sec-sev sec-sev-medium">unevaluated</span>
                  <span className="sec-label">
                    {c.label} ({c.category}) — run this blocker check
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
