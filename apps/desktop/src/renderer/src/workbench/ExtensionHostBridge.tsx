import { useCallback, useEffect, useState } from 'react';
import type { HostPromptRequest } from '../../../common/vscodeHost';
import { useWorkspace } from '../state/workspace';
import { useCommandRegistry } from '../commands/registry';
import { notifyError, notifyInfo } from '../notifications/bus';
import { setExtensionLanguageRoot } from '../editor/extensionProviders';
import { Modal, PromptModal } from './Modal';

/**
 * The window's half of the extension host.
 *
 * Four jobs, all of them things only the renderer can do:
 *
 *   1. **Report which file is active**, because that is the lazy-activation trigger. An
 *      extension that declares `onLanguage:python` must start when a Python file is opened and
 *      not one moment earlier, and only the workbench knows when that happened.
 *   2. **Ask the user what an extension wants to know.** Messages, quick picks and input boxes
 *      are blocking calls in the extension's own code, so the answer has to come back. A
 *      dismissed prompt resolves as dismissed — a real outcome extensions already handle —
 *      rather than as an invented answer.
 *   3. **Run workbench commands an extension asked for.** `vscode.commands.executeCommand`
 *      with an id no extension owns is AXIOM's own command, and the command registry lives
 *      here.
 *   4. **Say something when an extension gives up.** A crash loop that stops silently looks
 *      like a feature that quietly stopped working.
 *
 * Renders only the prompt, and only while one is outstanding.
 */
/**
 * The language id AXIOM would use for a path.
 *
 * Derived from the extension rather than asked of Monaco, because this runs on every tab
 * change and the answer only has to agree with what an extension's `onLanguage:` event says.
 * Anything unrecognized reports no language, which activates nothing — the correct outcome for
 * a file whose language AXIOM cannot name.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  sh: 'shellscript',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  swift: 'swift',
  kt: 'kotlin',
  dart: 'dart',
  lua: 'lua',
  vue: 'vue',
  svelte: 'svelte',
};

function languageForPath(path: string | null): string | null {
  if (path === null) return null;
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function ExtensionHostBridge() {
  const { rootPath, activePath, openFile } = useWorkspace();
  const { runCommand, getCommands, register, unregister } = useCommandRegistry();
  const [prompt, setPrompt] = useState<HostPromptRequest | null>(null);
  const [queue, setQueue] = useState<HostPromptRequest[]>([]);

  // Lazy activation follows the editor. Reported on every change, including to null, so an
  // extension's idea of the active editor cannot outlive the tab.
  useEffect(() => {
    void window.axiom.host
      .reportActiveEditor(activePath ?? null, languageForPath(activePath ?? null), rootPath ?? null)
      .catch(() => undefined);
  }, [activePath, rootPath]);

  // Language-provider commands and edits run against the open workspace, and this component already
  // holds it. Reported to the editor's provider bridge so a command an extension attached to a code
  // action or completion resolves in the same workspace the provider was asked about.
  useEffect(() => {
    setExtensionLanguageRoot(rootPath ?? null);
  }, [rootPath]);

  /**
   * Editor, resource and workspace context keys (PRD Phase 5 §5, §6).
   *
   * The keys upstream derives from the active editor, written from the one place that already knows
   * the active path and its language. Every key is sent on every change — empty string or `false`
   * for "nothing" rather than an omission — so a menu item can never stay visible for a file that
   * has been closed. `editorTextFocus` follows `document.activeElement` being inside the editor
   * surface, which is the honest answer available to the window.
   */
  useEffect(() => {
    const path = activePath ?? null;
    const language = languageForPath(path);
    const name = path === null ? '' : (path.split(/[\\/]/).pop() ?? '');
    const dot = name.lastIndexOf('.');
    const push = (): void => {
      const focused = document.activeElement?.closest('.editor-area, .monaco-editor') ?? null;
      void window.axiom.views
        .context({
          editorIsOpen: path !== null,
          editorFocus: path !== null && focused !== null,
          editorTextFocus: path !== null && focused !== null,
          editorLangId: language ?? '',
          resourceLangId: language ?? '',
          resource: path ?? '',
          resourcePath: path ?? '',
          resourceFilename: name,
          resourceExtname: dot > 0 ? name.slice(dot) : '',
          resourceDirname: path === null ? '' : path.slice(0, path.length - name.length - 1),
          resourceScheme: path === null ? '' : 'file',
          isFileSystemResource: path !== null,
          workspaceFolderCount: rootPath === null ? 0 : 1,
          workbenchState: rootPath === null ? 'empty' : 'folder',
        })
        .catch(() => undefined);
    };
    push();
    // Focus moves without the path changing — clicking from a tree into the editor is exactly the
    // transition `editorTextFocus` exists to describe.
    document.addEventListener('focusin', push);
    return () => document.removeEventListener('focusin', push);
  }, [activePath, rootPath]);

  useEffect(
    () =>
      window.axiom.host.onPrompt((request) => {
        // One at a time, in arrival order: two extensions asking at once must not stack modal
        // dialogs on top of each other.
        setQueue((pending) => [...pending, request]);
      }),
    [],
  );

  useEffect(() => {
    if (prompt !== null || queue.length === 0) return;
    setPrompt(queue[0] ?? null);
    setQueue((pending) => pending.slice(1));
  }, [prompt, queue]);

  useEffect(
    () =>
      window.axiom.host.onCrashLoop((info) => {
        notifyError(
          `${info.displayName} crashed ${info.crashes} times and was stopped. Open Extensions to restart or disable it.`,
          { source: 'Extensions' },
        );
      }),
    [],
  );

  useEffect(
    () =>
      window.axiom.host.onOpenFile((path) => {
        openFile(path, path.split(/[\\/]/).pop() ?? path);
      }),
    [openFile],
  );

  useEffect(
    () =>
      window.axiom.host.onWorkbenchCommand((command) => {
        // An unknown id is reported rather than ignored: an extension calling a command AXIOM
        // does not have is a real incompatibility, and silence makes it look like a hang.
        if (getCommands().some((entry) => entry.id === command)) runCommand(command);
        else {
          notifyInfo(`An extension asked for an unknown command: ${command}`, {
            source: 'Extensions',
          });
        }
      }),
    [runCommand, getCommands],
  );

  /**
   * Put invocable extension commands in the palette.
   *
   * Registered directly rather than through the `useCommands` helper because this list is
   * genuinely dynamic — it changes when an extension is installed, enabled or removed — while
   * that helper is built for a fixed list declared at compile time. Only commands backed by an
   * entry point are registered: a command with nothing behind it would fail the moment the
   * user picked it, and the Extensions view already reports it as declared-only.
   */
  useEffect(() => {
    let disposed = false;
    let registered: string[] = [];
    const load = (): void => {
      void window.axiom.market
        .contributions(rootPath ?? null)
        .then((catalog) => {
          if (disposed) return;
          for (const id of registered) unregister(id);
          registered = [];
          for (const command of catalog.commands) {
            if (!command.invocable) continue;
            const id = `ext.${command.command}`;
            register({
              id,
              title: command.title,
              category: command.extensionName,
              run: async () => {
                try {
                  await window.axiom.host.runCommand(command.command, [], rootPath ?? null);
                } catch (error) {
                  notifyError(error instanceof Error ? error.message : String(error), {
                    source: command.extensionName,
                  });
                }
              },
            });
            registered.push(id);
          }
        })
        .catch(() => undefined);
    };
    load();
    const stop = window.axiom.market.onChanged(() => load());
    return () => {
      disposed = true;
      stop();
      for (const id of registered) unregister(id);
    };
  }, [rootPath, register, unregister]);

  const answer = useCallback(
    (value: string | null) => {
      const current = prompt;
      setPrompt(null);
      if (current === null) return;
      void window.axiom.host.answerPrompt(current.id, value).catch(() => undefined);
    },
    [prompt],
  );

  if (prompt === null) return null;

  if (prompt.kind === 'inputBox') {
    return (
      <PromptModal
        title={prompt.displayName}
        label={prompt.prompt && prompt.prompt.length > 0 ? prompt.prompt : 'Enter a value'}
        initialValue={prompt.value ?? ''}
        placeholder={prompt.placeHolder ?? ''}
        password={prompt.password === true}
        confirmLabel="OK"
        onSubmit={(value) => answer(value)}
        onClose={() => answer(null)}
      />
    );
  }

  if (prompt.kind === 'quickPick') {
    return (
      <Modal title={prompt.displayName} onClose={() => answer(null)}>
        {prompt.placeHolder && prompt.placeHolder.length > 0 ? (
          <p className="host-prompt-text">{prompt.placeHolder}</p>
        ) : null}
        <div className="host-prompt-picks" role="group" aria-label="Choices">
          {(prompt.items ?? []).map((item) => (
            <button
              key={item}
              type="button"
              className="host-prompt-pick"
              onClick={() => answer(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  const items = prompt.items ?? [];
  return (
    <Modal
      title={prompt.displayName}
      onClose={() => answer(null)}
      footer={
        <>
          {items.map((item) => (
            <button key={item} type="button" className="btn" onClick={() => answer(item)}>
              {item}
            </button>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => answer(null)}>
            {items.length === 0 ? 'OK' : 'Dismiss'}
          </button>
        </>
      }
    >
      <p className={`host-prompt-text is-${prompt.severity ?? 'info'}`}>{prompt.message ?? ''}</p>
      <p className="host-prompt-source">From {prompt.extensionId}</p>
    </Modal>
  );
}
