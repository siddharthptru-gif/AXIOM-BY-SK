/**
 * Secrets & egress hardening review (Phase 272 — Secrets & Egress Hardening Review).
 *
 * PURE module (no I/O, no Electron). Reviews the app's EGRESS SURFACE — the set of
 * outbound network destinations — against a hardening policy: plain HTTP to a
 * non-loopback host is a failure, unexpected hosts (not on the allowlist) are
 * warnings, and any endpoint that carries secrets to a third party is flagged
 * high. Produces a pass / warn / fail verdict + findings. Complements the per-
 * request egress gateway (main/services/aiGateway) + redaction audit
 * (common/egressAudit) with a surface-level review. Deterministic.
 */

export interface EgressEndpoint {
  host: string;
  /** 'https' | 'http' | other. */
  protocol: string;
  purpose?: string;
  /** True when this destination receives credentials / secret material. */
  sendsSecrets?: boolean;
  /** True when this is a first-party / trusted destination. */
  firstParty?: boolean;
}

export type EgressVerdict = 'pass' | 'warn' | 'fail';
export type EgressSeverity = 'high' | 'medium' | 'low';

export interface EgressFinding {
  host: string;
  severity: EgressSeverity;
  issue: string;
}

export interface EgressReview {
  verdict: EgressVerdict;
  findings: EgressFinding[];
  endpoints: number;
  summary: string;
}

export interface EgressReviewOptions {
  /** Hosts expected/allowed (exact or suffix match). Others → warning. */
  allowedHosts?: string[];
}

export interface DiscoverEgressOptions {
  /** Hosts known to receive secrets/credentials (suffix match). */
  secretHosts?: string[];
  /** First-party / trusted host suffixes. */
  firstPartyHosts?: string[];
}

/**
 * Discover outbound endpoints from source/config text by extracting absolute URLs.
 *
 * PURE + bounded. This lets the egress review reflect the destinations actually
 * referenced in the selected workspace rather than a hard-coded list. Hosts are
 * de-duplicated (by host[:port] + protocol); secret/first-party classification is
 * applied from the provided suffix lists.
 */
export function discoverEgressEndpoints(
  text: string,
  options: DiscoverEgressOptions = {},
): EgressEndpoint[] {
  const source = String(text ?? '').slice(0, 1_000_000);
  const secretHosts = (options.secretHosts ?? []).map((h) => h.toLowerCase());
  const firstPartyHosts = (options.firstPartyHosts ?? []).map((h) => h.toLowerCase());
  const suffixMatch = (host: string, list: readonly string[]): boolean => {
    const h = host.toLowerCase().replace(/:\d+$/, '');
    return list.some((s) => h === s || h.endsWith(`.${s}`) || h.endsWith(s));
  };

  const urlPattern = /\b(https?|wss?|ftp):\/\/([a-z0-9._-]+(?::\d{1,5})?)/gi;
  const byKey = new Map<string, EgressEndpoint>();
  for (let m = urlPattern.exec(source); m; m = urlPattern.exec(source)) {
    const rawProto = m[1]!.toLowerCase();
    const host = m[2]!.toLowerCase();
    const protocol = rawProto === 'wss' ? 'https' : rawProto === 'ws' ? 'http' : rawProto;
    const key = `${protocol}://${host}`;
    if (byKey.has(key)) continue;
    if (byKey.size >= 200) break;
    byKey.set(key, {
      host,
      protocol,
      ...(suffixMatch(host, secretHosts) ? { sendsSecrets: true } : {}),
      ...(suffixMatch(host, firstPartyHosts) ? { firstParty: true } : {}),
    });
  }
  return [...byKey.values()].sort((a, b) => a.host.localeCompare(b.host));
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return LOOPBACK.has(h);
}

function onAllowlist(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return allowed.some((a) => {
    const al = a.toLowerCase();
    return h === al || h.endsWith(`.${al}`) || h.endsWith(al);
  });
}

/** Review one endpoint; returns its findings (worst-first is applied by the caller). */
function reviewEndpoint(ep: EgressEndpoint, allowed: readonly string[]): EgressFinding[] {
  const out: EgressFinding[] = [];
  const proto = ep.protocol.toLowerCase().replace(/:$/, '');
  const loopback = isLoopback(ep.host);

  if (proto !== 'https' && !loopback) {
    out.push({
      host: ep.host,
      severity: 'high',
      issue: `Insecure ${proto || 'plain'} egress to a non-loopback host — require HTTPS.`,
    });
  }
  if (ep.sendsSecrets === true && ep.firstParty !== true && !loopback) {
    out.push({
      host: ep.host,
      severity: 'high',
      issue: 'Sends secrets/credentials to a third-party host.',
    });
  }
  if (!loopback && ep.firstParty !== true && allowed.length > 0 && !onAllowlist(ep.host, allowed)) {
    out.push({ host: ep.host, severity: 'medium', issue: 'Host is not on the egress allowlist.' });
  }
  return out;
}

const SEV_RANK: Record<EgressSeverity, number> = { high: 2, medium: 1, low: 0 };

/** Review the whole egress surface against the hardening policy. */
export function reviewEgress(
  endpoints: readonly EgressEndpoint[],
  options: EgressReviewOptions = {},
): EgressReview {
  const allowed = options.allowedHosts ?? [];
  const findings: EgressFinding[] = [];
  for (const ep of endpoints) findings.push(...reviewEndpoint(ep, allowed));
  findings.sort(
    (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.host.localeCompare(b.host),
  );

  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasMed = findings.some((f) => f.severity === 'medium' || f.severity === 'low');
  const verdict: EgressVerdict = hasHigh ? 'fail' : hasMed ? 'warn' : 'pass';

  const summary =
    endpoints.length === 0
      ? 'Egress review: no outbound destinations.'
      : `Egress review: ${verdict.toUpperCase()} — ${endpoints.length} endpoint(s), ${findings.length} finding(s)` +
        (hasHigh ? ` (${findings.filter((f) => f.severity === 'high').length} high)` : '') +
        '.';

  return { verdict, findings, endpoints: endpoints.length, summary };
}
