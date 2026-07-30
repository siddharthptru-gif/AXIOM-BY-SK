import { clipboard, shell } from 'electron';

/**
 * OS integration helpers (Main process). Kept tiny and explicit; the renderer
 * reaches these only through allow-listed IPC (PRD Part X §178.4).
 */
export function revealInOS(path: string): void {
  shell.showItemInFolder(path);
}

export function writeClipboard(text: string): void {
  clipboard.writeText(text);
}

export function readClipboard(): string {
  return clipboard.readText();
}
