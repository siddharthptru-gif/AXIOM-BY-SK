import type { SettingsData } from '../../common/ipc';
import { parseEgressPolicy } from '../../common/aiSafety';
import { setEgressSafetyPolicy } from './aiGateway';
import { configureUpdates } from './updateService';

/**
 * Adopt committed user settings into Main-owned runtime policy. Keeping this at
 * the persistence boundary makes Settings UI, JSON-editor, and profile commits
 * behaviorally identical.
 */
export function applyRuntimeSettings(data: SettingsData): void {
  const values = data as Record<string, unknown>;
  setEgressSafetyPolicy(
    parseEgressPolicy(values['ai.safety.egressMode'], values['ai.safety.blockSeverity']),
  );
  // Applying settings must never trigger network I/O; this only updates policy
  // used by the existing update scheduler and future checks/downloads.
  configureUpdates({
    channel: typeof values['update.channel'] === 'string' ? values['update.channel'] : 'stable',
    autoDownload: values['update.autoDownload'] !== false,
  });
}
