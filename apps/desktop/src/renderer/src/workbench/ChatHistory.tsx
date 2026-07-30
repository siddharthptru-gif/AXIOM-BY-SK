import { useEffect, useMemo, useRef, useState } from 'react';
import { createDialogId, isTopDialog, registerDialog } from './dialogStack';
import type { AiConversation } from '../../../common/ipc';
import { searchThreads, exportThreadMarkdown, exportThreadJson } from '../../../common/chatThreads';
import { notifyInfo, notifyError } from '../notifications/bus';
import {
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  EditIcon,
  PinIcon,
  ShieldIcon,
  TrashIcon,
} from './icons';

/**
 * Chat history browser (PRD Epoch G §128.8 / Phase 179). A searchable overlay over
 * persisted threads: full-text search (title + bodies, ranked), pin, inline rename,
 * export (Markdown/JSON to a file, or copy to clipboard), delete, and resume. All
 * ranking/rendering logic lives in the pure `chatThreads` module; this is the UI.
 */
function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeFileStem(title: string): string {
  return (
    title
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'axiom-chat'
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function ChatHistory({
  conversations,
  legacyCount,
  activeId,
  onMigrateLegacy,
  onLoad,
  onDelete,
  onRename,
  onTogglePin,
  onClearAll,
  onClose,
}: {
  conversations: readonly AiConversation[];
  legacyCount: number;
  activeId: string | null;
  onMigrateLegacy: () => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const titleControlsRef = useRef(new Map<string, HTMLButtonElement>());
  const restoreFrameRef = useRef<number | null>(null);
  const dialogIdRef = useRef<number | null>(null);
  if (dialogIdRef.current === null) dialogIdRef.current = createDialogId();
  const editingIdRef = useRef<string | null>(null);
  const invokingControlRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const results = useMemo(() => searchThreads(conversations, query), [conversations, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const dialogId = dialogIdRef.current;
    if (!dialog || dialogId === null) return;
    const unregister = registerDialog(dialogId);
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    (searchRef.current ?? dialog).focus();

    const focusableElements = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) =>
          !element.hidden &&
          element.getAttribute('aria-hidden') !== 'true' &&
          element.getClientRects().length > 0,
      );

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isTopDialog(dialogId)) return;
      if (event.key === 'Escape') {
        if (
          event.target instanceof HTMLElement &&
          event.target.classList.contains('chat-history-rename')
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      unregister();
      const invokingControl = invokingControlRef.current;
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        // StrictMode's simulated cleanup leaves the dialog connected. Restore
        // focus only after an actual close/unmount.
        if (
          !dialogRef.current?.isConnected &&
          invokingControl?.isConnected &&
          !invokingControl.closest('[hidden]')
        ) {
          invokingControl.focus();
        }
      });
    };
  }, []);

  const exportToFile = async (thread: AiConversation, format: 'md' | 'json'): Promise<void> => {
    const content = format === 'json' ? exportThreadJson(thread) : exportThreadMarkdown(thread);
    try {
      const target = await window.axiom.dialog.saveFile(`${safeFileStem(thread.title)}.${format}`);
      if (!target) return;
      await window.axiom.fs.writeFile(target.path, content);
      notifyInfo(`Exported to ${target.name}`, { source: 'Axiom AI' });
    } catch (e) {
      notifyError('Could not export conversation', { source: 'Axiom AI', detail: detailOf(e) });
    }
  };

  const copyMarkdown = async (thread: AiConversation): Promise<void> => {
    try {
      await window.axiom.system.copyText(exportThreadMarkdown(thread));
      notifyInfo('Copied conversation as Markdown', { source: 'Axiom AI' });
    } catch (e) {
      notifyError('Could not copy conversation', { source: 'Axiom AI', detail: detailOf(e) });
    }
  };

  const focusConversation = (id: string | null): void => {
    window.requestAnimationFrame(() => {
      const control = id ? titleControlsRef.current.get(id) : null;
      (control ?? searchRef.current ?? dialogRef.current)?.focus();
    });
  };

  const beginRename = (thread: AiConversation): void => {
    editingIdRef.current = thread.id;
    setEditingId(thread.id);
    setDraft(thread.title);
  };
  const commitRename = (): void => {
    const id = editingIdRef.current;
    if (!id) return;
    editingIdRef.current = null;
    if (draft.trim().length > 0) onRename(id, draft);
    setEditingId(null);
    setDraft('');
    focusConversation(id);
  };
  const cancelRename = (): void => {
    const id = editingIdRef.current;
    editingIdRef.current = null;
    setEditingId(null);
    setDraft('');
    focusConversation(id);
  };
  const deleteConversation = (id: string, index: number): void => {
    const successor = results[index + 1]?.thread.id ?? results[index - 1]?.thread.id ?? null;
    if (editingIdRef.current === id) editingIdRef.current = null;
    onDelete(id);
    focusConversation(successor);
  };

  return (
    <div
      ref={dialogRef}
      className="chat-history"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-history-title"
      tabIndex={-1}
    >
      <div className="chat-history-head">
        <h2 id="chat-history-title" className="sr-only">
          Chat history
        </h2>
        <input
          ref={searchRef}
          className="chat-history-search"
          type="search"
          aria-label="Search conversations"
          placeholder={'Search conversations\u2026'}
          value={query}
          autoFocus
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          title="Close history"
          aria-label="Close history"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {results.length} {results.length === 1 ? 'conversation' : 'conversations'} found
      </div>

      {legacyCount > 0 ? (
        <div className="chat-history-legacy" role="note">
          <ShieldIcon size={14} />
          <span>
            {legacyCount} legacy {legacyCount === 1 ? 'conversation is' : 'conversations are'}
            unassigned. Import only if they belong to this workspace and provider connection.
          </span>
          <button type="button" className="btn btn-ghost" onClick={onMigrateLegacy}>
            Import legacy chats
          </button>
        </div>
      ) : null}

      <div className="chat-history-list" role="list" aria-label="Saved conversations">
        {results.length === 0 ? (
          <div className="chat-history-empty" role="status">
            {conversations.length === 0
              ? 'No saved conversations yet.'
              : 'No conversations match your search.'}
          </div>
        ) : (
          results.map(({ thread, snippet }, resultIndex) => {
            const hasFocus = focusedId === thread.id;
            const isCurrent = thread.id === activeId;
            return (
              <div
                key={thread.id}
                className={`chat-history-item${isCurrent || hasFocus ? ' is-active' : ''}${
                  hasFocus ? ' has-focus' : ''
                }`}
                role="listitem"
                onFocus={() => setFocusedId(thread.id)}
                onBlur={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                    setFocusedId((current) => (current === thread.id ? null : current));
                  }
                }}
              >
                <div className="chat-history-main">
                  {editingId === thread.id ? (
                    <input
                      className="chat-history-rename"
                      aria-label={`Rename ${thread.title}`}
                      value={draft}
                      autoFocus
                      spellCheck={false}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          cancelRename();
                        }
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <button
                      ref={(node) => {
                        if (node) titleControlsRef.current.set(thread.id, node);
                        else titleControlsRef.current.delete(thread.id);
                      }}
                      type="button"
                      className="chat-history-title"
                      title="Resume this conversation"
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => onLoad(thread.id)}
                    >
                      {thread.pinned ? (
                        <span className="chat-history-pindot" title="Pinned">
                          <PinIcon size={12} />
                          <span className="sr-only">Pinned</span>
                        </span>
                      ) : null}
                      <span className="chat-history-titletext">{thread.title}</span>
                    </button>
                  )}
                  {snippet ? <div className="chat-history-snippet">{snippet}</div> : null}
                  <div className="chat-history-meta">{timeAgo(thread.updatedAt)}</div>
                </div>
                <div
                  className="chat-history-actions"
                  role="group"
                  aria-label={`${thread.title} actions`}
                >
                  <button
                    type="button"
                    className={`chat-history-act${thread.pinned ? ' is-on' : ''}`}
                    title={thread.pinned ? 'Unpin' : 'Pin'}
                    aria-label={thread.pinned ? 'Unpin conversation' : 'Pin conversation'}
                    onClick={() => onTogglePin(thread.id)}
                  >
                    <PinIcon />
                  </button>
                  <button
                    type="button"
                    className="chat-history-act"
                    title="Rename"
                    aria-label="Rename conversation"
                    onClick={() => beginRename(thread)}
                  >
                    <EditIcon />
                  </button>
                  <button
                    type="button"
                    className="chat-history-act"
                    title="Export as Markdown file"
                    aria-label="Export as Markdown"
                    onClick={() => void exportToFile(thread, 'md')}
                  >
                    <DownloadIcon />
                  </button>
                  <button
                    type="button"
                    className="chat-history-act"
                    title="Copy as Markdown"
                    aria-label="Copy as Markdown"
                    onClick={() => void copyMarkdown(thread)}
                  >
                    <CopyIcon />
                  </button>
                  <button
                    type="button"
                    className="chat-history-act is-danger"
                    title="Delete"
                    aria-label="Delete conversation"
                    onClick={() => deleteConversation(thread.id, resultIndex)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="chat-history-foot">
        <span className="chat-history-count">
          {conversations.length} {conversations.length === 1 ? 'conversation' : 'conversations'}
        </span>
        {conversations.length > 0 ? (
          <button type="button" className="btn btn-ghost chat-history-clear" onClick={onClearAll}>
            <TrashIcon />
            <span>Clear all</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
