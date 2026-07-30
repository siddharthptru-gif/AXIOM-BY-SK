import { useState, type ReactNode } from 'react';
import { activeInsertText } from '../editor/activeEditorBus';
import { notifyInfo } from '../notifications/bus';
import { detectBlockPath, stripPathMarker } from '../../../common/codeBlocks';

export interface MarkdownActions {
  /** Create or update the workspace file a code block declares (via the Safe Edit Engine). */
  onCreateFile?: (path: string, code: string) => void;
  /** Open a `file:line` citation in the editor. */
  onOpenCitation?: (file: string, line: number) => void;
}

/**
 * Lightweight, dependency-free markdown rendering for chat (PRD Epoch G). Handles
 * the constructs a coding assistant actually emits: fenced code blocks (with a
 * language label + Copy button), inline `code`, and **bold**. All text flows
 * through React (escaped), so it is XSS-safe. Streaming-friendly: an unterminated
 * fence simply renders as text until its closing ``` arrives.
 */
interface CodeSegment {
  type: 'code';
  lang: string;
  code: string;
}
interface TextSegment {
  type: 'text';
  text: string;
}
type Segment = CodeSegment | TextSegment;

function splitSegments(input: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```([\w+#.-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(input)) !== null) {
    if (m.index > last) segments.push({ type: 'text', text: input.slice(last, m.index) });
    segments.push({ type: 'code', lang: m[1] ?? '', code: m[2] ?? '' });
    last = fence.lastIndex;
  }
  if (last < input.length) segments.push({ type: 'text', text: input.slice(last) });
  return segments;
}

/** Render inline `code`, **bold**, and `file:line` citations within a text run. */
function renderInline(
  text: string,
  onOpenCitation?: (file: string, line: number) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const inline = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\b[\w.\-]+(?:\/[\w.\-]+)*\.[A-Za-z]\w{0,7}:\d+\b)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key++} className="chat-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      // file:line citation
      const cite = /^(.+):(\d+)$/.exec(token);
      const isUrlPart = m.index > 0 && text[m.index - 1] === '/';
      if (cite && onOpenCitation && !isUrlPart) {
        const file = cite[1]!;
        const line = Number.parseInt(cite[2]!, 10);
        nodes.push(
          <button
            key={key++}
            type="button"
            className="chat-citation"
            title={`Open ${file} at line ${line}`}
            onClick={() => onOpenCitation(file, line)}
          >
            {token}
          </button>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = inline.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function CodeBlock({
  lang,
  code,
  onCreateFile,
}: {
  lang: string;
  code: string;
  onCreateFile?: (path: string, code: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const body = code.replace(/\n$/, '');
  const filePath = detectBlockPath(body);
  const copy = (): void => {
    void window.axiom.system.copyText(body).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="chat-code">
      <div className="chat-code-head">
        <span className="chat-code-lang">{filePath ?? (lang || 'code')}</span>
        <div className="chat-code-actions">
          {filePath && onCreateFile ? (
            <button
              type="button"
              className="chat-code-btn"
              title={`Create or update ${filePath} (snapshotted)`}
              onClick={() => onCreateFile(filePath, stripPathMarker(body))}
            >
              Create file
            </button>
          ) : null}
          <button
            type="button"
            className="chat-code-btn"
            title="Insert into the active editor"
            onClick={() => {
              if (!activeInsertText(body)) {
                notifyInfo('Open a file in the editor to insert code.', { source: 'Axiom AI' });
              }
            }}
          >
            Insert
          </button>
          <button type="button" className="chat-code-btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre className="chat-code-body">
        <code>{body}</code>
      </pre>
    </div>
  );
}

function TextBlock({
  text,
  onOpenCitation,
}: {
  text: string;
  onOpenCitation?: (file: string, line: number) => void;
}) {
  const trimmed = text.replace(/^\n+/, '').replace(/\n+$/, '');
  if (!trimmed) return null;
  return <div className="chat-text">{renderInline(trimmed, onOpenCitation)}</div>;
}

/** Render a chat message body as lightweight markdown. */
export function renderMarkdown(text: string, actions?: MarkdownActions): ReactNode {
  return splitSegments(text).map((seg, i) =>
    seg.type === 'code' ? (
      <CodeBlock
        key={i}
        lang={seg.lang}
        code={seg.code}
        {...(actions?.onCreateFile ? { onCreateFile: actions.onCreateFile } : {})}
      />
    ) : (
      <TextBlock
        key={i}
        text={seg.text}
        {...(actions?.onOpenCitation ? { onOpenCitation: actions.onOpenCitation } : {})}
      />
    ),
  );
}
