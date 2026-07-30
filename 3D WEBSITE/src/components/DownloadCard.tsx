import { useState } from 'react';
import { RELEASE, RELEASE_SIZE, VERIFY_COMMAND } from '../lib/release';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-hairline py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="w-24 shrink-0 text-[11px] uppercase tracking-[0.16em] text-fg-faint">
        {label}
      </span>
      <span className="min-w-0 break-all font-mono text-[12.5px] text-fg">{children}</span>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded-md border border-hairline px-2 py-0.5 font-sans text-[10px] uppercase tracking-[0.14em] text-fg-faint transition-colors hover:border-violet/50 hover:text-fg"
      aria-label={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * The one conversion surface on the site.
 *
 * Every fact here is real and derived from `lib/release.ts` — the size is computed
 * from the byte count, and the hash is the actual SHA-256 of the file being served.
 * The unsigned-build warning is stated up front rather than left for SmartScreen to
 * deliver, because a surprise security dialog is what makes people abandon a download.
 */
export function DownloadCard() {
  const [verifyOpen, setVerifyOpen] = useState(false);

  return (
    <div className="glass w-full max-w-[34rem] rounded-2xl p-7 sm:p-9">
      <h2 className="font-display text-2xl font-semibold text-fg-max sm:text-3xl">Download AXIOM</h2>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        One installer. No account, no licence key, no trial timer.
      </p>

      <a className="btn-primary mt-7 w-full" href={RELEASE.downloadPath} download>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Download for Windows
      </a>
      <p className="mt-3 text-center font-mono text-[11px] text-fg-faint">
        v{RELEASE.version} · {RELEASE_SIZE} · {RELEASE.platform}
      </p>

      <div className="mt-7">
        <Row label="File">{RELEASE.fileName}</Row>
        <Row label="Version">{RELEASE.version}</Row>
        <Row label="Size">
          {RELEASE_SIZE} ({RELEASE.bytes.toLocaleString('en-US')} bytes)
        </Row>
        <Row label="Platform">{RELEASE.platform}</Row>
        <Row label="SHA-256">
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all text-ice">{RELEASE.sha256}</span>
            <CopyButton value={RELEASE.sha256} label="the SHA-256 checksum" />
          </span>
        </Row>
      </div>

      <button
        type="button"
        className="mt-5 flex w-full items-center justify-between rounded-lg border border-hairline px-4 py-3 text-left text-xs text-fg-muted transition-colors hover:border-violet/40 hover:text-fg"
        aria-expanded={verifyOpen}
        onClick={() => setVerifyOpen((value) => !value)}
      >
        <span>Verify your download</span>
        <span aria-hidden="true" className="font-mono text-fg-faint">
          {verifyOpen ? '\u2212' : '+'}
        </span>
      </button>

      {verifyOpen ? (
        <div className="mt-3 rounded-lg border border-hairline bg-[#07070d] p-4">
          <p className="text-xs leading-relaxed text-fg-muted">
            Open Command Prompt in your Downloads folder and run:
          </p>
          <pre className="mt-3 overflow-x-auto font-mono text-[11.5px] leading-relaxed text-ice">
            {VERIFY_COMMAND}
          </pre>
          <p className="mt-3 text-xs leading-relaxed text-fg-faint">
            The hash it prints must match the SHA-256 above, ignoring case. If it does not,
            delete the file and download it again.
          </p>
        </div>
      ) : null}

      <div className="mt-6 border-t border-hairline pt-5">
        <h3 className="text-[11px] uppercase tracking-[0.16em] text-fg-faint">Requirements</h3>
        <ul className="mt-3 flex flex-col gap-1.5 text-xs leading-relaxed text-fg-muted">
          <li>Windows 10 or 11, 64-bit</li>
          <li>About 400 MB of free disk space</li>
          <li>
            An API key from any supported provider — or{' '}
            <span className="text-ice">Ollama</span> for fully local, keyless use
          </li>
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-fg-faint">
          This build is unsigned, so Windows SmartScreen will warn you the first time you run it.
          Choose <span className="text-fg">More info</span> then{' '}
          <span className="text-fg">Run anyway</span> — and verify the checksum above first if
          you would rather not take that on trust.
        </p>
      </div>
    </div>
  );
}
