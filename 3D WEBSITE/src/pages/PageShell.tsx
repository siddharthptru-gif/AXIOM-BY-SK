import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { SplitText } from '../components/SplitText';

/**
 * Shared frame for the document routes. No 3D behind long-form text: the scene would
 * fight the copy for attention and cost battery for nothing.
 */
export function PageShell({
  title,
  subtitle,
  updated,
  children,
}: {
  title: string;
  subtitle: string;
  updated?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} — AXIOM`;
    window.scrollTo(0, 0);
  }, [title]);

  return (
    <main className="relative z-10 min-h-screen bg-canvas">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{
          background: 'radial-gradient(80% 100% at 50% 0%, #1a1440 0%, transparent 75%)',
        }}
      />
      <div className="relative mx-auto max-w-7xl px-6 pb-24 pt-32 md:px-10">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-xs text-fg-faint transition-colors hover:text-fg"
        >
          <span aria-hidden="true">←</span> Back to AXIOM
        </Link>

        <h1 className="mt-6 font-display text-4xl font-semibold tracking-[-0.02em] text-fg-max md:text-5xl">
          <SplitText text={title} />
        </h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-fg-muted md:text-base">
          {subtitle}
        </p>
        {updated ? (
          <p className="mt-3 font-mono text-[11px] text-fg-faint">Last updated {updated}</p>
        ) : null}

        <div className="grad-rule mt-9" />

        <div className="prose-axiom mt-4">{children}</div>
      </div>
    </main>
  );
}
