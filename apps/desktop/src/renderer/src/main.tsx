import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initLsp } from './editor/lsp';
import { initDebugConsole } from './state/debugConsole';
import { initInlineCompletion } from './editor/inlineCompletion';
import { initExtensionLanguages } from './editor/extensionProviders';
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/global.css';
import './styles/premium.css';

function RendererRecoveryScreen() {
  return (
    <main className="renderer-recovery" role="alert">
      <section className="renderer-recovery-card" aria-labelledby="renderer-recovery-title">
        <h1 id="renderer-recovery-title">Axiom needs to reload</h1>
        <p>The interface encountered a problem. Your files and account credentials are safe.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload Axiom
        </button>
      </section>
    </main>
  );
}

class RendererErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error('Axiom renderer entered recovery mode.', error, info);
    } else {
      console.error('Axiom renderer entered recovery mode.');
    }
  }

  render(): ReactNode {
    return this.state.failed ? <RendererRecoveryScreen /> : this.props.children;
  }
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const root = createRoot(container);

try {
  // Wire Monaco to the language server (hover/completion/diagnostics), once.
  initLsp();

  // Capture debug adapter output from startup, so the Debug Console has a
  // transcript whether or not the Run and Debug view was ever opened.
  initDebugConsole();

  // Register the AI inline-completion (ghost text) provider, once (PRD §129.1).
  initInlineCompletion();

  // Mirror extension language providers into Monaco and keep the host's document
  // copies in step with the editor's (PRD Phase 6).
  initExtensionLanguages();

  root.render(
    <RendererErrorBoundary>
      <StrictMode>
        <App />
      </StrictMode>
    </RendererErrorBoundary>,
  );
} catch (error: unknown) {
  if (import.meta.env.DEV) {
    console.error('Axiom renderer initialization failed.', error);
  } else {
    console.error('Axiom renderer initialization failed.');
  }
  root.render(<RendererRecoveryScreen />);
}
