import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <main className="relative z-10 flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
      <span className="font-mono text-6xl grad-text">404</span>
      <h1 className="mt-5 font-display text-2xl text-fg-max">This page does not exist.</h1>
      <p className="mt-3 max-w-[38ch] text-sm text-fg-muted">
        The link may be out of date. Everything on this site lives on four pages.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link className="btn-primary" to="/">
          Back to AXIOM
        </Link>
        <Link className="btn-ghost" to="/docs">
          Documentation
        </Link>
      </div>
    </main>
  );
}
