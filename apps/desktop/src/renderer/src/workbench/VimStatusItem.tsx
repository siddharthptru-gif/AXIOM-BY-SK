import { useEffect, useState } from 'react';
import { subscribeVimStatus, type VimStatus } from '../editor/vimBus';
import { vimModeLabel } from '../../../common/vim';

/**
 * Vim mode indicator (PRD Phase 249). Shows the focused editor's Vim mode in the
 * status bar (or nothing when the Vim keymap is off). Self-contained: subscribes to
 * the vim status bus the editor publishes to.
 */
export function VimStatusItem() {
  const [mode, setMode] = useState<VimStatus>(null);
  useEffect(() => subscribeVimStatus(setMode), []);
  if (!mode) return null;
  return (
    <span className="status-item vim-status" title="Vim mode (editor.keymap)">
      {`-- ${vimModeLabel(mode)} --`}
    </span>
  );
}
