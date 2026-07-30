import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { FlagValue, MemoryEntry, SaveFileResult, TelemetryConsent } from '../../common/ipc';
import type { AgentPreset } from '../../common/agentPresets';
import { readSettings } from './settings';
import { listMemories } from './memory';
import { readAudit } from './audit';
import { getConsent, uploadPreview, type TelemetryUploadStatus } from './telemetry';
import { getAllFlags } from './featureFlags';
import { listCustomAgents } from './customAgents';
import { saveFile } from './dialog';

/**
 * Data export / portability (PRD Epoch E §32.3 / Phase 124). Gathers the user's
 * LOCAL, user-owned data into a single JSON bundle they can save — settings,
 * long-term memory, custom agents, an audit summary, telemetry consent, and
 * resolved feature flags. Secrets NEVER appear: API keys/tokens live in the OS
 * vault and are not read here, and a defensive `redactDeep` pass strips any
 * secret-shaped fields just in case (INV-3).
 */
const SECRET_KEY = /key|token|secret|password|auth|credential/i;

/** Deep-clone a value, replacing any secret-shaped string field with a marker. */
export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'ai.custom.headers') {
        // This setting is JSON encoded, so ordinary object traversal cannot see
        // secret header values. Preserve valid header names for portability but
        // redact every value; malformed/non-object encodings fail closed.
        if (typeof v === 'string') {
          try {
            const parsed: unknown = JSON.parse(v);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              out[k] = JSON.stringify(
                Object.fromEntries(
                  Object.keys(parsed as Record<string, unknown>).map((name) => [
                    name,
                    '[redacted]',
                  ]),
                ),
              );
            } else {
              out[k] = '[redacted]';
            }
          } catch {
            out[k] = '[redacted]';
          }
        } else {
          out[k] = '[redacted]';
        }
        continue;
      }
      out[k] = typeof v === 'string' && SECRET_KEY.test(k) ? '[redacted]' : redactDeep(v);
    }
    return out;
  }
  return value;
}

export interface AuditSummary {
  count: number;
  recent: Array<{ seq: number; ts: number; type: string; summary: string }>;
}

export interface ExportBundle {
  axiomDataExport: true;
  version: number;
  exportedAt: string;
  settings: Record<string, unknown>;
  telemetryConsent: TelemetryConsent;
  telemetryUpload: TelemetryUploadStatus;
  featureFlags: Record<string, FlagValue>;
  memory: MemoryEntry[];
  customAgents: AgentPreset[];
  audit: AuditSummary;
}

/** Assemble the bundle from gathered parts (pure — redaction applied here). */
export function assembleExport(parts: {
  settings: Record<string, unknown>;
  telemetryConsent: TelemetryConsent;
  telemetryUpload: TelemetryUploadStatus;
  featureFlags: Record<string, FlagValue>;
  memory: MemoryEntry[];
  customAgents: AgentPreset[];
  audit: AuditSummary;
  now: number;
}): ExportBundle {
  return {
    axiomDataExport: true,
    version: 1,
    exportedAt: new Date(parts.now).toISOString(),
    settings: redactDeep(parts.settings) as Record<string, unknown>,
    telemetryConsent: parts.telemetryConsent,
    telemetryUpload: parts.telemetryUpload,
    featureFlags: parts.featureFlags,
    memory: parts.memory,
    customAgents: parts.customAgents,
    audit: parts.audit,
  };
}

/** Gather all local user data into an export bundle. */
export async function buildExport(): Promise<ExportBundle> {
  const [settings, memory, auditEvents, customAgents] = await Promise.all([
    readSettings(),
    listMemories(),
    readAudit(50),
    listCustomAgents(),
  ]);
  const telemetryConsent = await getConsent();
  const telemetryUpload = await uploadPreview();
  return assembleExport({
    settings: settings as Record<string, unknown>,
    telemetryConsent,
    telemetryUpload,
    featureFlags: getAllFlags(),
    memory,
    customAgents,
    audit: {
      count: auditEvents.length,
      recent: auditEvents.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, summary: e.summary })),
    },
    now: Date.now(),
  });
}

/** Build the export and atomically commit it only while its owner remains live. */
export async function saveExport(owner: BrowserWindow): Promise<SaveFileResult | null> {
  if (owner.isDestroyed()) return null;
  const controller = new AbortController();
  const onOwnerClosed = (): void => controller.abort();
  let tempPath: string | null = null;
  owner.once('closed', onOwnerClosed);
  try {
    const json = JSON.stringify(await buildExport(), null, 2);
    // Export assembly and the native picker are asynchronous. If the requesting
    // window closes during either phase, do not create or replace the destination.
    if (controller.signal.aborted || owner.isDestroyed()) return null;
    const target = await saveFile('axiom-data-export.json', owner);
    if (!target || controller.signal.aborted || owner.isDestroyed()) return null;

    tempPath = join(
      dirname(target.path),
      `.axiom-export-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
    );
    const handle = await fs.open(tempPath, 'wx');
    try {
      await handle.writeFile(json, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (controller.signal.aborted || owner.isDestroyed()) return null;

    // Rename is the commit point. A close observed before it leaves the selected
    // destination untouched; a close after it does not misreport a committed file.
    await fs.rename(tempPath, target.path);
    tempPath = null;
    return target;
  } finally {
    if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => undefined);
    owner.removeListener('closed', onOwnerClosed);
  }
}
