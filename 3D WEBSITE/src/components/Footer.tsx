import { Link } from 'react-router-dom';
import { RELEASE, RELEASE_SIZE } from '../lib/release';

export function Footer() {
  return (
    <footer className="relative z-10 border-t border-hairline bg-void/90 backdrop-blur-xl">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:px-10">
        <div>
          <span className="font-display text-lg tracking-[0.22em] text-fg-max">AXIOM</span>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.2em] grad-text">
            Vibe. Build. Anything.
          </p>
          <p className="mt-5 max-w-xs text-sm leading-relaxed text-fg-faint">
            A desktop AI coding IDE for Windows. Free, no account, bring your own model key. Your
            files stay on your machine.
          </p>
        </div>

        <div>
          <h3 className="mb-4 font-display text-xs uppercase tracking-[0.18em] text-fg-faint">
            Product
          </h3>
          <ul className="flex flex-col gap-2.5 text-sm">
            <li>
              <a
                href={RELEASE.downloadPath}
                download
                className="text-fg-muted transition-colors hover:text-fg-max"
              >
                Download for Windows
              </a>
            </li>
            <li>
              <Link to="/docs" className="text-fg-muted transition-colors hover:text-fg-max">
                Documentation
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="mb-4 font-display text-xs uppercase tracking-[0.18em] text-fg-faint">
            Legal
          </h3>
          <ul className="flex flex-col gap-2.5 text-sm">
            <li>
              <Link to="/terms" className="text-fg-muted transition-colors hover:text-fg-max">
                Terms of Use
              </Link>
            </li>
            <li>
              <Link to="/privacy" className="text-fg-muted transition-colors hover:text-fg-max">
                Privacy Policy
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="mb-4 font-display text-xs uppercase tracking-[0.18em] text-fg-faint">
            Release
          </h3>
          <ul className="flex flex-col gap-2.5 font-mono text-xs text-fg-faint">
            <li>v{RELEASE.version}</li>
            <li>{RELEASE.platform}</li>
            <li>{RELEASE_SIZE}</li>
            <li>Unsigned build</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-hairline">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-6 py-6 text-xs text-fg-faint md:flex-row md:items-center md:justify-between md:px-10">
          <span>AXIOM — an independent project. No company entity, no analytics, no tracking.</span>
          <span className="font-mono">Built with AXIOM.</span>
        </div>
      </div>
    </footer>
  );
}
