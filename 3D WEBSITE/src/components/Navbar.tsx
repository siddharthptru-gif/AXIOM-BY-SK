import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RELEASE } from '../lib/release';

const LINKS: ReadonlyArray<{ label: string; to: string }> = [
  { label: 'Docs', to: '/docs' },
  { label: 'Terms', to: '/terms' },
  { label: 'Privacy', to: '/privacy' },
];

/**
 * The wordmark is set in type, not placed as an image. It stays sharp at any zoom, costs
 * no request, and cannot arrive late and shift the header.
 */
function Logo() {
  return (
    <Link to="/" className="group flex flex-col gap-[3px]" aria-label="AXIOM home">
      <span className="font-display text-lg font-semibold leading-none tracking-[0.22em] text-fg-max">
        AXIOM
      </span>
      <span
        aria-hidden="true"
        className="h-[1px] w-0 transition-[width] duration-500 group-hover:w-full"
        style={{
          background: 'linear-gradient(90deg, #8b5cf6, #22d3ee)',
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />
    </Link>
  );
}

export function Navbar() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? 'border-b border-hairline bg-void/80 backdrop-blur-xl'
          : 'border-b border-transparent'
      }`}
    >
      <nav className="mx-auto flex max-w-[1340px] items-center justify-between px-[18px] py-6 md:px-[15px] md:py-9">
        <div className="flex items-center gap-6">
          <Logo />
          <div className="hidden items-center gap-6 md:flex">
            {LINKS.map((link, idx) => (
              <Link
                key={link.to}
                to={link.to}
                className="nav-link-underline flex items-baseline gap-1.5 text-xs font-medium uppercase tracking-[-0.12px] text-fg-muted transition-colors hover:text-fg-max"
              >
                <span className="font-mono text-[8px] font-medium uppercase tracking-[-0.08px] text-fg-faint">
                  0{idx + 1} /
                </span>
                <span>{link.label}</span>
              </Link>
            ))}
          </div>
        </div>

        <div className="hidden items-center gap-5 md:flex">
          <span className="font-mono text-[11px] text-fg-faint">v{RELEASE.version}</span>
          <a className="btn-primary !px-6 !py-2.5 !text-sm" href={RELEASE.downloadPath} download>
            Download
          </a>
        </div>

        <button
          type="button"
          className="flex h-10 w-10 flex-col items-center justify-center gap-[5px] md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="block h-[1.5px] w-5 bg-fg transition-all duration-300"
              style={{
                transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                transform:
                  open && index === 0
                    ? 'translateY(6.5px) rotate(45deg)'
                    : open && index === 2
                      ? 'translateY(-6.5px) rotate(-45deg)'
                      : 'none',
                opacity: open && index === 1 ? 0 : 1,
              }}
            />
          ))}
        </button>
      </nav>

      {/* Mobile panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-[85%] max-w-[340px] border-l border-hairline bg-void/95 backdrop-blur-xl transition-transform duration-300 md:hidden ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
        aria-hidden={!open}
      >
        <div className="flex h-full flex-col gap-2 px-7 pb-10 pt-24">
          {LINKS.map((link, index) => (
            <Link
              key={link.to}
              to={link.to}
              tabIndex={open ? 0 : -1}
              className="border-b border-hairline py-4 font-display text-xl text-fg transition-colors hover:text-fg-max"
              style={{
                opacity: open ? 1 : 0,
                transform: open ? 'translateX(0)' : 'translateX(18px)',
                transition: `opacity 400ms ${150 + index * 75}ms, transform 400ms ${150 + index * 75}ms`,
              }}
            >
              {link.label}
            </Link>
          ))}
          <a
            className="btn-primary mt-auto w-full"
            href={RELEASE.downloadPath}
            download
            tabIndex={open ? 0 : -1}
            style={{
              opacity: open ? 1 : 0,
              transition: 'opacity 400ms 450ms',
            }}
          >
            Download for Windows
          </a>
        </div>
      </div>
    </header>
  );
}
